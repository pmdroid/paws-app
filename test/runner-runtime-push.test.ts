import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PUBLICATION_STAGING_FAILURE } from "../src/github";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";

function git(args: string[], cwd: string) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

/**
 * `rejection` is GitHub's refusal of a push, or null once GitHub takes pushes again. `moved` is a
 * commit someone else pushed to the branch on GitHub while the turn ran.
 */
async function fixture(
  rejection: string | (() => string | null),
  moved?: { file: string; content: string },
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-push-"));
  const now = Date.now();
  let clock = 0;
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "file.txt"), "base\n");
  git(["add", "."], source);
  git(["commit", "-q", "-m", "base"], source);
  const baseSha = git(["rev-parse", "HEAD"], source);
  git(["clone", "-q", "--bare", source, join(root, "origin.git")], root);
  let movedSha: string | null = null;
  if (moved) {
    const other = join(root, "other");
    git(["clone", "-q", join(root, "origin.git"), other], root);
    writeFileSync(join(other, moved.file), moved.content);
    git(["add", "."], other);
    git(["commit", "-q", "-m", "moved"], other);
    git(["push", "-q", "origin", "HEAD:refs/heads/paws/fixture"], other);
    movedSha = git(["rev-parse", "HEAD"], other);
  }
  writeFileSync(join(source, "file.txt"), "candidate\n");
  git(["commit", "-q", "-am", "candidate"], source);
  const candidateSha = git(["rev-parse", "HEAD"], source);
  git(["bundle", "create", "-q", join(root, "candidate.bundle"), `${baseSha}..HEAD`], source);
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  for (const directory of [spool.root, results.root]) {
    mkdirSync(directory);
    chmodSync(directory, 0o750);
  }
  const command: RunnerCommand = {
    id: "command",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
    issuedAt: now,
    expiresAt: now + 3_600_000,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha,
    },
    profile: { agent: "claude", model: null },
    prompt: "Implement the assigned issue",
  };
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  let pending: RunnerCommand[] = [command];
  let execution = "";
  const posted: RunnerResult[] = [];
  const pushes: number[] = [];
  const fetches: number[] = [];
  const runtime = await openRunnerRuntime({
    root,
    spool,
    results,
    repositoryRoot: join(root, "repositories"),
    home: root,
    now: () => now,
    monotonic: () => clock,
    onError: () => {},
    async networkGit(input) {
      if (input.operation === "clone")
        git(["clone", "-q", "--bare", join(root, "origin.git"), input.dest!], input.cwd);
      else if (input.operation === "fetch") {
        fetches.push(clock);
        git(["fetch", "-q", join(root, "origin.git"), "+refs/heads/*:refs/heads/*"], input.dest!);
      } else if (input.operation === "push") {
        pushes.push(clock);
        const refused = typeof rejection === "string" ? rejection : rejection();
        if (refused !== null) throw new Error(refused);
        const target = input.refspec!.split(":")[1]!;
        git(
          [
            "push",
            "-q",
            ...(input.lease ? [`--force-with-lease=${target}:${input.lease}`] : []),
            join(root, "origin.git"),
            input.refspec!,
          ],
          input.cwd,
        );
      }
    },
    broker: {
      async start(id) {
        execution = id;
        const directory = join(results.root, id);
        mkdirSync(directory);
        chmodSync(directory, 0o750);
        writeFileSync(join(directory, "events.jsonl"), "");
        chmodSync(join(directory, "events.jsonl"), 0o640);
        return { alreadyAdmitted: false };
      },
      async stop() {},
      alive: () => true,
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
      },
      async pollCommands() {
        return { commands: pending, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => pending,
      async acknowledgeCommand(id) {
        pending = pending.filter((entry) => entry.id !== id);
      },
      async issueRunGrant() {
        return { token: "token", expiresAt: now + 3_600_000 };
      },
      async sendEvent() {
        return { duplicate: false };
      },
      async answers() {
        return { answers: [] };
      },
      async postResult(_runId, _generation, result) {
        posted.push(result);
        return { duplicate: false };
      },
      async repositoryCredential(_runId, _generation, access) {
        return {
          token: "fixture-token",
          expiresAt: now + 3_600_000,
          remoteUrl: command.repository.remoteUrl,
          branch: access === "write" ? "paws/fixture" : null,
        };
      },
      async renewCertificate() {
        return paired;
      },
      async uploadArtifact() {
        return { ok: true };
      },
      async uploadTranscript(_runId, chunk) {
        return { offset: chunk.offset, duplicate: false };
      },
      async finishTranscript() {
        return { uri: "transcript" };
      },
    },
  });
  const tick = () => runtime.tick().catch(() => {});
  const started = () => execution !== "";
  for (let index = 0; index < 400 && !started(); index++) {
    await tick();
    await Bun.sleep(1);
  }
  const directory = join(results.root, execution);
  copyFileSync(join(root, "candidate.bundle"), join(directory, "candidate.bundle"));
  chmodSync(join(directory, "candidate.bundle"), 0o640);
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({
      executionId: execution,
      commandId: command.id,
      run: {
        role: "implementer",
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
      },
      candidateSha,
    }),
  );
  chmodSync(join(directory, "result.json"), 0o640);
  return {
    posted,
    pushes,
    fetches,
    candidateSha,
    movedSha,
    remoteBranch: (branch: string) =>
      git(["rev-parse", `refs/heads/${branch}`], join(root, "origin.git")),
    remoteGit: (args: string[]) => git(args, join(root, "origin.git")),
    async run(minutes: number) {
      for (let step = 0; step <= minutes * 2; step++) {
        for (let index = 0; index < 5; index++) {
          await tick();
          await Bun.sleep(1);
        }
        clock += 30_000;
      }
    },
    async cleanup() {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a candidate push GitHub keeps failing stops after six tries over about 15 minutes with the error and branch",
  async () => {
    const f = await fixture(
      "fatal: unable to access 'https://github.com/fixture/repository.git/': The requested URL returned error: 502",
    );
    try {
      await f.run(20);
      expect(f.pushes).toEqual([0, 0, 60_000, 180_000, 420_000, 900_000]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.stopReason).toBe("error");
      expect(f.posted[0]!.pushFailure).toEqual({
        branch: "paws/fixture",
        error: expect.stringContaining("The requested URL returned error: 502"),
      });
      expect(f.posted[0]!.errorMessage).toContain("paws/fixture");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

const DENIED_TO_APP =
  "remote: Permission to fixture/repository.git denied to paws-test[bot].\nfatal: unable to access 'https://github.com/fixture/repository.git/': The requested URL returned error: 403";

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a turn finished during a push outage keeps its commit and pushes it when the outage ends",
  async () => {
    let outage = true;
    const f = await fixture(() => (outage ? DENIED_TO_APP : null));
    try {
      await f.run(20);
      // One push, then 1, 2, 5 and 10 minutes apart; nothing is posted and nothing is asked.
      expect(f.pushes).toEqual([0, 60_000, 180_000, 480_000, 1_080_000]);
      expect(f.posted).toEqual([]);
      outage = false;
      await f.run(10);
      expect(f.pushes.at(-1)).toBe(1_680_000);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.pushFailure).toBeUndefined();
      expect(f.posted[0]!.candidateSha).toBe(f.candidateSha);
      expect(f.remoteBranch("paws/fixture")).toBe(f.candidateSha);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a candidate push GitHub refuses for the workflows permission stops on the first try",
  async () => {
    const f = await fixture(
      "To https://github.com/fixture/repository.git\n ! [remote rejected] abc -> paws/fixture (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nerror: failed to push some refs to 'https://github.com/fixture/repository.git'",
    );
    try {
      await f.run(2);
      expect(f.pushes).toEqual([0]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.pushFailure).toEqual({
        branch: "paws/fixture",
        error: expect.stringContaining("without `workflows` permission"),
      });
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a candidate that cannot be staged for the push stops on the first try without blaming GitHub",
  async () => {
    const f = await fixture(`${PUBLICATION_STAGING_FAILURE}: fatal: couldn't find remote ref HEAD`);
    try {
      await f.run(2);
      expect(f.pushes).toEqual([0]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.pushFailure).toEqual({
        branch: "paws/fixture",
        error: `${PUBLICATION_STAGING_FAILURE}: fatal: couldn't find remote ref HEAD`,
      });
      expect(f.posted[0]!.errorMessage).toContain("could not be staged for the push");
      expect(f.posted[0]!.errorMessage).not.toContain("GitHub rejected");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

const STALE_INFO =
  "To https://github.com/fixture/repository.git\n ! [rejected]        abc -> paws/fixture (stale info)\nerror: failed to push some refs to 'https://github.com/fixture/repository.git'";

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a stale-info rejection rebases the turn's commits onto the moved branch and pushes them without a question",
  async () => {
    let refusals = 1;
    const f = await fixture(() => (refusals-- > 0 ? STALE_INFO : null), {
      file: "other.txt",
      content: "moved\n",
    });
    try {
      await f.run(2);
      expect(f.fetches).toHaveLength(1);
      expect(f.pushes).toHaveLength(2);
      expect(f.posted).toHaveLength(1);
      const [result] = f.posted;
      expect(result!.pushFailure).toBeUndefined();
      expect(result!.stopReason).toBe("end_turn");
      const head = f.remoteBranch("paws/fixture");
      expect(result!.candidateSha).toBe(head);
      expect(head).not.toBe(f.candidateSha);
      // The agent's own commit, unchanged, on top of the commit the branch moved to.
      expect(f.remoteGit(["rev-parse", `${head}^`])).toBe(f.movedSha!);
      expect(f.remoteGit(["show", "-s", "--format=%s%n%an <%ae>%n%cn", head])).toBe(
        "candidate\nFixture <fixture@example.invalid>\nFixture",
      );
      expect(f.remoteGit(["show", `${head}:file.txt`])).toBe("candidate");
      expect(f.remoteGit(["show", `${head}:other.txt`])).toBe("moved");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a non-fast-forward rejection rebases onto the moved branch and pushes again",
  async () => {
    const f = await fixture(() => null, { file: "other.txt", content: "moved\n" });
    try {
      await f.run(2);
      expect(f.pushes).toHaveLength(2);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.pushFailure).toBeUndefined();
      expect(f.posted[0]!.candidateSha).toBe(f.remoteBranch("paws/fixture"));
      expect(f.remoteGit(["rev-parse", "refs/heads/paws/fixture^"])).toBe(f.movedSha!);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a rebase onto the moved branch that conflicts reports the conflicting files and leaves the branch alone",
  async () => {
    const f = await fixture(() => null, { file: "file.txt", content: "moved\n" });
    try {
      await f.run(2);
      expect(f.pushes).toHaveLength(1);
      expect(f.remoteBranch("paws/fixture")).toBe(f.movedSha!);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.stopReason).toBe("error");
      expect(f.posted[0]!.pushFailure).toEqual({
        branch: "paws/fixture",
        error: expect.stringContaining("conflicted in file.txt"),
        conflicts: ["file.txt"],
      });
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a 403 is not rebased: the branch is never fetched and the push waits as an outage",
  async () => {
    const f = await fixture(DENIED_TO_APP, { file: "other.txt", content: "moved\n" });
    try {
      await f.run(10);
      expect(f.pushes.length).toBeGreaterThan(1);
      expect(f.fetches).toEqual([]);
      expect(f.posted).toEqual([]);
      expect(f.remoteBranch("paws/fixture")).toBe(f.movedSha!);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
