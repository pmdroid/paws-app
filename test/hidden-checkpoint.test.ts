import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { git } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import type { RunnerJob } from "../src/runner-execution";
import { checkpointRef, createRunnerRepositories } from "../src/runner-repositories";
import { CHECKPOINT_COMMIT_MESSAGE, executeRunnerCommand } from "../src/runner-worker";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const BRANCH = "paws/eng-1-hidden-checkpoints";
const HIDDEN = `refs/paws/checkpoints/${BRANCH}`;
const WORKING = "working on the findings contract";
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-hidden-checkpoint-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  mkdirSync(source);
  await git(["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "original.txt"), "original");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-qm", "initial"], { env });
  const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  await git(["clone", "-q", "--bare", source, remote]);
  await git(["--git-dir", remote, "update-ref", `refs/heads/${BRANCH}`, baseSha]);
  const repositories = createRunnerRepositories({
    root: join(root, "cache"),
    home: join(root, "home"),
    credential: async () => "synthetic",
    networkGit: async (input) => {
      if (input.operation === "clone")
        await git(["clone", "-q", "--bare", remote, input.dest!], { env });
      else if (input.operation === "fetch")
        await git(
          [
            "--git-dir",
            input.dest!,
            "fetch",
            "-q",
            remote,
            input.refspec ?? "+refs/heads/*:refs/heads/*",
          ],
          { env },
        );
      else {
        const target = input.refspec!.split(":")[1]!;
        await git(
          [
            "--git-dir",
            input.cwd,
            "push",
            "-q",
            ...(input.lease ? [`--force-with-lease=${target}:${input.lease}`] : []),
            remote,
            input.refspec!,
          ],
          { env },
        );
      }
    },
  });
  let executions = 0;
  const command = (extra: Partial<Extract<RunnerJob["command"], { type: "run" }>> = {}) =>
    ({
      id: `cmd${++executions}`,
      type: "run",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: `01J0000000000000000000RUN${executions}`,
      itemId: "item",
      generation: 1,
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      profile: { agent: "claude", model: "fixture-model" },
      repository: {
        owner: "acme",
        repo: "repo",
        remoteUrl: "https://github.com/acme/repo.git",
        baseSha,
      },
      prompt: "Implement the request",
      ...extra,
    }) as Extract<RunnerJob["command"], { type: "run" }>;
  const remoteRef = (ref: string) =>
    git(["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref]).then(
      (out) => out.trim(),
      () => "",
    );
  async function execute(
    run: Extract<RunnerJob["command"], { type: "run" }>,
    steps: FakeScript["steps"],
    extra: Partial<Parameters<typeof executeRunnerCommand>[0]> = {},
  ) {
    const { bundle } = await repositories.prepare(run);
    chmodSync(bundle, 0o600);
    const output = join(root, "output", run.id);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(root, `${run.id}.json`),
      JSON.stringify({ model: "fixture-model", sessionId: "session", steps }),
    );
    const checkout = join(root, "work", run.runId);
    const events = () =>
      existsSync(join(output, "events.jsonl"))
        ? readFileSync(join(output, "events.jsonl"), "utf8")
        : "";
    const running = executeRunnerCommand({
      job: { executionId: `01J0000000000000000000EXE${run.id.slice(3)}`, command: run },
      repositoryBundle: bundle,
      outputDirectory: output,
      workRoot: join(root, "work"),
      home: join(root, "home"),
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [fakeAgent, join(root, `${run.id}.trace.json`), join(root, `${run.id}.json`)],
      },
      ...extra,
    });
    const checkpoints = () =>
      events()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; reason?: string; sha?: string })
        .filter((event) => event.type === "checkpoint" && event.sha);
    let lease: string | undefined;
    const pushCheckpoint = async (sha: string) => {
      await repositories.publish(
        run,
        {
          bundle: readFileSync(join(output, `checkpoint-${sha}.bundle`)),
          sha,
          branch: BRANCH,
          ref: checkpointRef(BRANCH),
        },
        undefined,
        lease,
      );
      lease = sha;
    };
    const publishCandidate = async (sha: string) =>
      repositories.publish(run, {
        bundle: readFileSync(join(output, "candidate.bundle")),
        sha,
        branch: BRANCH,
        rebase: true,
      });
    return { running, checkout, events, checkpoints, pushCheckpoint, publishCandidate };
  }
  const until = async (ready: () => boolean) => {
    for (let index = 0; index < 1000 && !ready(); index++) await delay(10);
    expect(ready()).toBe(true);
  };
  const commitOn = async (from: string, ref: string, file: string) => {
    await git(["-C", source, "checkout", "-q", "--detach", from]);
    writeFileSync(join(source, file), file);
    await git(["-C", source, "add", file]);
    await git(["-C", source, "commit", "-qm", `Add ${file}`], { env });
    const sha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    await git(["-C", source, "push", "-q", "--force", remote, `${sha}:${ref}`]);
    return sha;
  };
  return { baseSha, remote, command, remoteRef, execute, until, commitOn };
}

const working: FakeScript["steps"][number] = {
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: WORKING } },
};

test.skipIf(!linux)(
  "interval and stop checkpoints go to the hidden ref and leave the item's branch alone",
  async () => {
    const f = await fixture();
    let ask!: () => void;
    const asked = new Promise<void>((resolve) => (ask = resolve));
    const turn = await f.execute(f.command(), [working, { type: "hang" }], {
      checkpointIntervalMs: 100,
      async checkpoint(sequence, signal) {
        if (sequence > 1)
          await new Promise((_, reject) => signal.addEventListener("abort", reject));
        await asked;
      },
    });
    await f.until(() => turn.events().includes(WORKING));
    writeFileSync(join(turn.checkout, "contract.ts"), "export type Finding = {};\n");
    await f.until(() => turn.checkpoints().some((event) => event.reason === "interval"));
    const interval = turn.checkpoints().find((event) => event.reason === "interval")!.sha!;
    await turn.pushCheckpoint(interval);
    expect(await f.remoteRef(HIDDEN)).toBe(interval);
    expect(await f.remoteRef(`refs/heads/${BRANCH}`)).toBe(f.baseSha);

    writeFileSync(join(turn.checkout, "ui.tsx"), "<Findings />\n");
    ask();
    await turn.running;
    const stop = turn.checkpoints().find((event) => event.reason === "stop")!.sha!;
    expect(stop).not.toBe(interval);
    await turn.pushCheckpoint(stop);
    expect(await f.remoteRef(HIDDEN)).toBe(stop);
    expect(await f.remoteRef(`refs/heads/${BRANCH}`)).toBe(f.baseSha);
    expect((await git(["--git-dir", f.remote, "log", "-1", "--format=%s", HIDDEN])).trim()).toBe(
      CHECKPOINT_COMMIT_MESSAGE,
    );
  },
);

test.skipIf(!linux)(
  "a restarted run starts at the branch head with its checkpoint uncommitted, and its candidate carries no WIP commit",
  async () => {
    const f = await fixture();
    let ask!: () => void;
    const asked = new Promise<void>((resolve) => (ask = resolve));
    const first = await f.execute(f.command(), [working, { type: "hang" }], {
      checkpointIntervalMs: 3_600_000,
      async checkpoint(sequence, signal) {
        if (sequence > 1)
          await new Promise((_, reject) => signal.addEventListener("abort", reject));
        await asked;
      },
    });
    await f.until(() => first.events().includes(WORKING));
    writeFileSync(join(first.checkout, "contract.ts"), "export type Finding = {};\n");
    ask();
    await first.running;
    const saved = first.checkpoints().find((event) => event.reason === "stop")!.sha!;
    await first.pushCheckpoint(saved);

    const second = await f.execute(
      f.command({ restoreCheckpoint: { sha: saved, branch: BRANCH } }),
      [working, { ...working, delayMs: 1_500 }, { type: "end", stopReason: "end_turn" }],
      { checkpointIntervalMs: 3_600_000 },
    );
    await f.until(() => second.events().includes(WORKING));
    expect((await git(["-C", second.checkout, "rev-parse", "HEAD"])).trim()).toBe(f.baseSha);
    expect((await git(["-C", second.checkout, "status", "--porcelain"])).trim()).toBe(
      "?? contract.ts",
    );
    expect(readFileSync(join(second.checkout, "contract.ts"), "utf8")).toBe(
      "export type Finding = {};\n",
    );
    await git(["-C", second.checkout, "add", "contract.ts"], { env });
    await git(["-C", second.checkout, "commit", "-qm", "Add the findings contract"], { env });
    const result = await second.running;
    expect(result.candidateSha).toMatch(/^[a-f0-9]{40}$/);
    expect(await second.publishCandidate(result.candidateSha!)).toBe(result.candidateSha!);
    expect(await f.remoteRef(`refs/heads/${BRANCH}`)).toBe(result.candidateSha!);
    const subjects = (
      await git(["--git-dir", f.remote, "log", "--format=%s", `refs/heads/${BRANCH}`])
    )
      .trim()
      .split("\n");
    expect(subjects).toEqual(["Add the findings contract", "initial"]);
    expect(subjects).not.toContain(CHECKPOINT_COMMIT_MESSAGE);
  },
);

test.skipIf(!linux)(
  "a checkpoint the agent rebased onto main restores on its own commits instead of being dropped",
  async () => {
    const f = await fixture();
    const branchHead = await f.commitOn(f.baseSha, `refs/heads/${BRANCH}`, "branch.txt");
    const main = await f.commitOn(f.baseSha, "refs/heads/main", "main.txt");
    const repository = {
      owner: "acme",
      repo: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
      baseSha: branchHead,
      mainSha: main,
    };
    let ask!: () => void;
    const asked = new Promise<void>((resolve) => (ask = resolve));
    const first = await f.execute(f.command({ repository }), [working, { type: "hang" }], {
      checkpointIntervalMs: 3_600_000,
      async checkpoint(sequence, signal) {
        if (sequence > 1)
          await new Promise((_, reject) => signal.addEventListener("abort", reject));
        await asked;
      },
    });
    await f.until(() => first.events().includes(WORKING));
    await git(["-C", first.checkout, "reset", "-q", "--hard", main], { env });
    writeFileSync(join(first.checkout, "branch.txt"), "branch.txt");
    await git(["-C", first.checkout, "add", "branch.txt"], { env });
    await git(["-C", first.checkout, "commit", "-qm", "Rebase the branch work onto main"], {
      env,
    });
    const rebased = (await git(["-C", first.checkout, "rev-parse", "HEAD"])).trim();
    writeFileSync(join(first.checkout, "ui.tsx"), "<Findings />\n");
    ask();
    await first.running;
    const saved = first.checkpoints().find((event) => event.reason === "stop")!.sha!;
    await first.pushCheckpoint(saved);
    expect(
      git(["--git-dir", f.remote, "merge-base", "--is-ancestor", branchHead, saved]),
    ).rejects.toThrow();

    const stop = new AbortController();
    const second = await f.execute(
      f.command({ repository, restoreCheckpoint: { sha: saved, branch: BRANCH } }),
      [working, { type: "hang" }],
      { checkpointIntervalMs: 3_600_000, signal: stop.signal },
    );
    await f.until(() => second.events().includes(WORKING));
    expect((await git(["-C", second.checkout, "rev-parse", "HEAD"])).trim()).toBe(rebased);
    expect((await git(["-C", second.checkout, "status", "--porcelain"])).trim()).toBe("?? ui.tsx");
    expect(await f.remoteRef(`refs/heads/${BRANCH}`)).toBe(branchHead);
    stop.abort();
    await second.running.catch(() => undefined);
  },
);
