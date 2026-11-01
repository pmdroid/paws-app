import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";

const linuxUser =
  process.platform === "linux" && process.getuid!() !== 0 && process.getgid!() !== 0;

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

type CrashPoint = "before-push" | "after-push" | "transcript-upload" | "transcript-seal";
type Authority = "live" | "fenced" | "unrenewed" | "down";

const METADATA = {
  sessionId: "agent-session",
  identity: { session: "agent-session", model: "fixture-model", provider: "fixture" },
  closeoutReport: "Closeout passed every check.",
  tokens: 1234,
};

async function fixture(options: { crashAt?: CrashPoint; moved?: boolean; freeze?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-publication-"));
  const now = Date.now();
  let clock = 0;
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "file.txt"), "base\n");
  git(["add", "."], source);
  git(["commit", "-q", "-m", "base"], source);
  const baseSha = git(["rev-parse", "HEAD"], source);
  const origin = join(root, "origin.git");
  git(["clone", "-q", "--bare", source, origin], root);
  let movedSha: string | null = null;
  if (options.moved) {
    const other = join(root, "other");
    git(["clone", "-q", origin, other], root);
    writeFileSync(join(other, "other.txt"), "moved\n");
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
  const command: Extract<RunnerCommand, { type: "run" }> = {
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
  let crashAt = options.crashAt;
  let crashed = false;
  let authority: Authority = "live";
  let current = 0;
  const posted: RunnerResult[] = [];
  const pushes: string[] = [];
  const starts: string[] = [];
  const reports: string[][] = [];
  const errors: string[] = [];
  const transcript = { uploaded: new Map<number, string>(), finished: [] as number[] };
  const hang = () => new Promise<never>(() => {});
  function crash(point: CrashPoint) {
    if (crashAt !== point) return;
    crashAt = undefined;
    crashed = true;
    if (options.freeze !== false) current++;
    throw new Error("runner process killed");
  }
  function open() {
    const instance = ++current;
    const gate = async () => {
      if (instance !== current) await hang();
    };
    let frozenAt: number | undefined;
    return openRunnerRuntime({
      root,
      spool,
      results,
      repositoryRoot: join(root, "repositories"),
      home: root,
      now: () => now,
      monotonic: () => (instance === current ? clock : (frozenAt ??= clock)),
      stopWaitMs: 10,
      onError: (error) => {
        if (instance === current) errors.push(error.message);
      },
      async networkGit(input) {
        await gate();
        if (input.operation === "clone")
          git(["clone", "-q", "--bare", origin, input.dest!], input.cwd);
        else if (input.operation === "fetch")
          git(["fetch", "-q", origin, "+refs/heads/*:refs/heads/*"], input.dest!);
        else if (input.operation === "push") {
          crash("before-push");
          const target = input.refspec!.split(":")[1]!;
          git(
            [
              "push",
              "-q",
              ...(input.lease ? [`--force-with-lease=${target}:${input.lease}`] : []),
              origin,
              input.refspec!,
            ],
            input.cwd,
          );
          pushes.push(input.refspec!.split(":")[0]!);
          const pushed = git(["rev-parse", target], origin);
          if (!options.moved || pushed !== movedSha) crash("after-push");
        }
      },
      broker: {
        async start(id) {
          await gate();
          execution = id;
          starts.push(id);
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
        async heartbeat(_skills, _runtimes, _agents, live) {
          await gate();
          if (authority === "down") throw new Error("ECONNREFUSED");
          reports.push((live ?? []).map((value) => value.runId));
          if (authority === "fenced")
            return { leases: [], fenced: [{ runId: "run", generation: 1 }] };
          if (authority === "unrenewed") return { leases: [], fenced: [] };
          return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
        },
        async pollCommands() {
          await gate();
          return { commands: pending, rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => pending,
        async acknowledgeCommand(id) {
          await gate();
          pending = pending.filter((entry) => entry.id !== id);
        },
        async issueRunGrant() {
          await gate();
          if (authority === "down") throw new Error("ECONNREFUSED");
          return { token: "token", expiresAt: now + 3_600_000 };
        },
        async sendEvent() {
          await gate();
          return { duplicate: false };
        },
        async answers() {
          await gate();
          return { answers: [] };
        },
        async postResult(_runId, _generation, result) {
          await gate();
          posted.push(result);
          return { duplicate: false };
        },
        async repositoryCredential(_runId, _generation, access) {
          await gate();
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
          await gate();
          return { ok: true };
        },
        async uploadTranscript(_runId, chunk) {
          await gate();
          crash("transcript-upload");
          transcript.uploaded.set(chunk.offset, chunk.data);
          return { offset: chunk.offset, duplicate: false };
        },
        async finishTranscript(_runId, finish) {
          await gate();
          transcript.finished.push(finish.sizeBytes);
          crash("transcript-seal");
          return { uri: "transcript" };
        },
      },
    });
  }
  const runtimes = [await open()];
  const tick = () =>
    runtimes
      .at(-1)!
      .tick()
      .catch(() => {});
  async function settle(until: () => boolean, limit = 400) {
    for (let index = 0; index < limit && !until(); index++) {
      await tick();
      await Bun.sleep(1);
    }
  }
  await settle(() => execution !== "");
  const directory = join(results.root, execution);
  copyFileSync(join(root, "candidate.bundle"), join(directory, "candidate.bundle"));
  chmodSync(join(directory, "candidate.bundle"), 0o640);
  appendFileSync(
    join(directory, "events.jsonl"),
    `${JSON.stringify({ type: "progress", text: "finished the change" })}\n`,
  );
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
        ...METADATA,
      },
      candidateSha,
    }),
  );
  chmodSync(join(directory, "result.json"), 0o640);
  const journal = <T>(read: (db: Database) => T) => {
    const db = new Database(join(root, "executions.db"), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  return {
    posted,
    pushes,
    starts,
    reports,
    errors,
    transcript,
    candidateSha,
    movedSha,
    baseSha,
    crashed: () => crashed,
    settle,
    tick,
    remoteGit: (args: string[]) => git(args, origin),
    remoteBranch: () => git(["rev-parse", "refs/heads/paws/fixture"], origin),
    authority: (value: Authority) => (authority = value),
    cancel: () =>
      pending.push({
        id: "cancel",
        type: "cancel",
        runId: "run",
        generation: 1,
        runnerId: "runner",
        workspaceId: "workspace",
        issuedAt: now,
        expiresAt: now + 60_000,
      }),
    advance: (ms: number) => (clock += ms),
    publication: () =>
      journal((db) =>
        db
          .query<{ publishedSha: string | null; refused: string | null; phase: string }, []>(
            "SELECT p.published_sha AS publishedSha,p.refused,e.phase FROM publication p JOIN execution e ON e.id=p.execution_id",
          )
          .get(),
      ),
    savedResults: () =>
      journal(
        (db) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM result_delivery").get()!.n,
      ),
    async restart() {
      if (options.freeze !== false) current--;
      runtimes.push(await open());
    },
    async gracefulRestart() {
      await runtimes.at(-1)!.stop();
      runtimes.push(await open());
    },
    async cleanup() {
      current++;
      for (const runtime of runtimes) await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function expectRealOutcome(result: RunnerResult | undefined, candidateSha: string) {
  expect(result).toMatchObject({
    role: "implementer",
    stopReason: "end_turn",
    agentExited: true,
    candidateSha,
    ...METADATA,
  });
  expect(result!.errorMessage).toBeUndefined();
  expect(result!.pushFailure).toBeUndefined();
}

for (const crashAt of [
  "before-push",
  "after-push",
  "transcript-upload",
  "transcript-seal",
] as const)
  test.skipIf(!linuxUser)(
    `a runner crash ${crashAt} resumes the finished turn after restart and delivers it unchanged`,
    async () => {
      const f = await fixture({ crashAt });
      try {
        await f.settle(f.crashed);
        expect(f.crashed()).toBe(true);
        expect(f.posted).toEqual([]);
        expect(f.publication()?.phase).toBe("publishing");
        await f.restart();
        await f.settle(() => f.posted.length > 0);
        expect(f.reports.at(-1)).toEqual(["run"]);
        expect(f.posted).toHaveLength(1);
        expectRealOutcome(f.posted[0], f.candidateSha);
        expect(f.remoteBranch()).toBe(f.candidateSha);
        expect(f.publication()).toMatchObject({ publishedSha: f.candidateSha, refused: null });
        expect(f.starts).toHaveLength(1);
        expect([...f.transcript.uploaded.keys()]).toEqual([0]);
        expect(new Set(f.transcript.finished).size).toBe(1);
        expect(f.errors.join("\n")).toContain("resumes publishing the finished turn");
        expect(f.errors.join("\n")).not.toContain("The runner stopped this run");
      } finally {
        await f.cleanup();
      }
    },
    30_000,
  );

test.skipIf(!linuxUser)(
  "a crash after a rebased push reconciles the rebased commit instead of pushing another",
  async () => {
    const f = await fixture({ crashAt: "after-push", moved: true });
    try {
      await f.settle(f.crashed);
      const rebased = f.remoteBranch();
      expect(rebased).not.toBe(f.candidateSha);
      expect(f.remoteGit(["rev-parse", `${rebased}^`])).toBe(f.movedSha!);
      expect(f.publication()?.publishedSha).toBeNull();
      await f.restart();
      await f.settle(() => f.posted.length > 0);
      expect(f.posted).toHaveLength(1);
      expectRealOutcome(f.posted[0], rebased);
      expect(f.remoteBranch()).toBe(rebased);
      expect(f.remoteGit(["rev-list", "--count", `${f.baseSha}..${rebased}`])).toBe("2");
      expect(f.publication()?.publishedSha).toBe(rebased);
      expect(f.starts).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(!linuxUser)(
  "a graceful stop while publishing keeps the finished turn and the next start delivers it",
  async () => {
    const f = await fixture({ crashAt: "before-push", freeze: false });
    try {
      await f.settle(f.crashed);
      await f.gracefulRestart();
      expect(f.publication()?.phase).toBe("publishing");
      await f.settle(() => f.posted.length > 0);
      expect(f.posted).toHaveLength(1);
      expectRealOutcome(f.posted[0], f.candidateSha);
      expect(f.starts).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

for (const ending of ["fenced", "unrenewed", "cancelled"] as const)
  test.skipIf(!linuxUser)(
    `a finished turn whose generation is ${ending} after restart is kept as refused, not posted`,
    async () => {
      const f = await fixture({ crashAt: "after-push" });
      try {
        await f.settle(f.crashed);
        if (ending === "cancelled") f.cancel();
        else f.authority(ending);
        await f.restart();
        await f.settle(() => f.publication()?.phase === "interrupted", 50);
        for (let index = 0; index < 5; index++) await f.tick();
        expect(f.posted).toEqual([]);
        expect(f.savedResults()).toBe(0);
        const publication = f.publication();
        expect(publication?.phase).toBe("interrupted");
        expect(publication?.refused).toBe(
          ending === "fenced"
            ? "fenced by Paws"
            : ending === "unrenewed"
              ? "heartbeat did not renew the lease"
              : "cancelled by Paws",
        );
        expect(f.errors.join("\n")).toContain("kept the finished turn");
        expect(f.starts).toHaveLength(1);
      } finally {
        await f.cleanup();
      }
    },
    30_000,
  );

test.skipIf(!linuxUser)(
  "a lease that lapses while publishing keeps the outcome instead of posting an agent failure",
  async () => {
    const f = await fixture({ crashAt: "before-push" });
    try {
      await f.settle(f.crashed);
      f.authority("down");
      await f.restart();
      await f.tick();
      f.advance(6 * 60_000);
      await Bun.sleep(400);
      expect(f.publication()).toMatchObject({
        phase: "interrupted",
        refused: "lease deadline passed",
      });
      expect(f.posted).toEqual([]);
      expect(f.savedResults()).toBe(0);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
