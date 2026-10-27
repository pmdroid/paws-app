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
import { CHECKPOINT_COMMIT_MESSAGE, executeRunnerCommand } from "../src/runner-worker";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const EXECUTION = "01J00000000000000000000001";
const WORKING = "working on the findings contract";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-checkpoint-worker-"));
  roots.push(root);
  const source = join(root, "source");
  const home = join(root, "home");
  const workRoot = join(root, "work");
  const output = join(root, "output", EXECUTION);
  for (const path of [source, home, output]) mkdirSync(path, { recursive: true });
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "original.txt"), "original");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "initial"], { env });
  const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  const repositoryBundle = join(root, "source.bundle");
  await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
  chmodSync(repositoryBundle, 0o600);
  const runId = "01J0000000000000000000RUN1";
  const command: RunnerJob["command"] = {
    id: "cmd",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId,
    itemId: "item",
    generation: 2,
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
  };
  const checkout = join(workRoot, runId);
  const events = () =>
    existsSync(join(output, "events.jsonl"))
      ? readFileSync(join(output, "events.jsonl"), "utf8")
      : "";
  const checkpoints = () =>
    events()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; reason?: string; sha?: string })
      .filter((event) => event.type === "checkpoint");
  const until = async (ready: () => boolean) => {
    for (let index = 0; index < 1000 && !ready(); index++) await delay(10);
    expect(ready()).toBe(true);
  };
  /** The agent works, then hangs until Paws stops it, like a turn whose checks never end. */
  function execute(extra: Partial<Parameters<typeof executeRunnerCommand>[0]>) {
    const steps: FakeScript["steps"] = [
      {
        type: "update",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: WORKING } },
      },
      { type: "hang" },
    ];
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({ model: "fixture-model", sessionId: "session", steps }),
    );
    return executeRunnerCommand({
      job: { executionId: EXECUTION, command },
      repositoryBundle,
      outputDirectory: output,
      workRoot,
      home,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [fakeAgent, join(root, "trace.json"), join(root, "script.json")],
      },
      ...extra,
    });
  }
  /** A commit the agent makes in its checkout. */
  async function commit(file: string, content: string) {
    writeFileSync(join(checkout, file), content);
    await git(["-C", checkout, "add", file], { env });
    await git(["-C", checkout, "commit", "-q", "-m", `Add ${file}`], { env });
    return (await git(["-C", checkout, "rev-parse", "HEAD"])).trim();
  }
  /** A clone of the base with the published checkpoint checked out, as Paws would fetch it. */
  async function published(sha: string) {
    const clone = join(root, `published-${sha}`);
    await git(["clone", "-q", source, clone]);
    const bundle = join(output, `checkpoint-${sha}.bundle`);
    const [, ref] = (await git(["bundle", "list-heads", bundle])).trim().split(" ");
    await git(["-C", clone, "fetch", "-q", bundle, ref!]);
    await git(["-C", clone, "checkout", "-q", "FETCH_HEAD"]);
    expect((await git(["-C", clone, "rev-parse", "HEAD"])).trim()).toBe(sha);
    return clone;
  }
  return {
    baseSha,
    checkout,
    output,
    events,
    checkpoints,
    until,
    execute,
    commit,
    published,
  };
}

test.skipIf(!linux)(
  "a turn stopped for the time cap publishes a WIP commit with both of its commits first",
  async () => {
    const context = await fixture();
    const stop = new AbortController();
    let ask!: () => void;
    const asked = new Promise<void>((resolve) => (ask = resolve));
    let first = "";
    let second = "";
    const running = context.execute({
      signal: stop.signal,
      checkpointIntervalMs: 3_600_000,
      async checkpoint(sequence, signal) {
        if (sequence > 1)
          await new Promise((_, reject) => signal.addEventListener("abort", reject));
        await asked;
      },
    });
    await context.until(() => context.events().includes(WORKING));
    first = await context.commit("contract.ts", "export type Finding = {};\n");
    second = await context.commit("contract.test.ts", "test('finding');\n");
    writeFileSync(join(context.checkout, "ui.tsx"), "<Findings />\n");
    // Paws hits the time cap and asks for the checkpoint before it cancels the run. The worker
    // halts the agent first, so the turn ends without Paws aborting it.
    ask();
    const result = await running;
    expect(stop.signal.aborted).toBe(false);
    expect(result.run.cancelled).toBe(true);
    expect(result.candidateSha).toBeUndefined();
    // The snapshot is taken after the agent's turn ended, so no later change can miss it.
    const lines = context.events().trim().split("\n");
    const ended = lines.findIndex((line) => line.includes('"type":"cancelled"'));
    const saving = lines.findIndex((line) => line.includes('"type":"checkpoint"'));
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(saving).toBeGreaterThan(ended);
    const [saved] = context.checkpoints();
    expect(saved).toMatchObject({ type: "checkpoint", reason: "stop" });
    const sha = saved!.sha!;
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    // The WIP commit sits on the agent's two commits and holds the change it had not committed.
    const clone = await context.published(sha);
    expect((await git(["-C", clone, "rev-parse", "HEAD^"])).trim()).toBe(second);
    expect((await git(["-C", clone, "rev-parse", "HEAD^^"])).trim()).toBe(first);
    expect((await git(["-C", clone, "rev-parse", "HEAD^^^"])).trim()).toBe(context.baseSha);
    expect((await git(["-C", clone, "log", "-1", "--format=%s"])).trim()).toBe(
      CHECKPOINT_COMMIT_MESSAGE,
    );
    expect(readFileSync(join(clone, "contract.ts"), "utf8")).toBe("export type Finding = {};\n");
    expect(readFileSync(join(clone, "contract.test.ts"), "utf8")).toBe("test('finding');\n");
    expect(readFileSync(join(clone, "ui.tsx"), "utf8")).toBe("<Findings />\n");
    // The agent's own branch, index and files stay as they were.
    expect((await git(["-C", context.checkout, "rev-parse", "HEAD"])).trim()).toBe(second);
    expect((await git(["-C", context.checkout, "status", "--porcelain"])).trim()).toBe("?? ui.tsx");
    expect((await git(["-C", context.checkout, "for-each-ref", "refs/paws"])).trim()).toBe("");
  },
);

test.skipIf(!linux)(
  "a stop with nothing new since the base still answers, without a commit",
  async () => {
    const context = await fixture();
    const stop = new AbortController();
    const running = context.execute({
      signal: stop.signal,
      checkpointIntervalMs: 3_600_000,
      async checkpoint(sequence, signal) {
        if (sequence > 1)
          await new Promise((_, reject) => signal.addEventListener("abort", reject));
        while (!context.events().includes(WORKING)) await delay(10, undefined, { signal });
      },
    });
    await context.until(() => context.checkpoints().length === 1);
    stop.abort();
    await running;
    expect(context.checkpoints()).toEqual([{ type: "checkpoint", reason: "stop" }]);
  },
);

test.skipIf(!linux)(
  "a long turn publishes a checkpoint after the interval when its worktree changed, and not when it did not",
  async () => {
    const context = await fixture();
    const stop = new AbortController();
    const running = context.execute({ signal: stop.signal, checkpointIntervalMs: 100 });
    await context.until(() => context.events().includes(WORKING));
    // Several intervals pass with the worktree still at the base: nothing is published.
    await delay(450);
    expect(context.checkpoints()).toEqual([]);
    const commit = await context.commit("contract.ts", "export type Finding = {};\n");
    await context.until(() => context.checkpoints().length === 1);
    // More intervals with no change publish nothing more.
    await delay(450);
    stop.abort();
    await running;
    // A clean worktree's checkpoint is the agent's own commit.
    expect(context.checkpoints()).toEqual([
      { type: "checkpoint", reason: "interval", sha: commit },
    ]);
    const clone = await context.published(commit);
    expect(readFileSync(join(clone, "contract.ts"), "utf8")).toBe("export type Finding = {};\n");
  },
);

test.skipIf(!linux)(
  "a stop publishes the worktree again even when an interval already emitted it, in case that push failed",
  async () => {
    const context = await fixture();
    let ask!: () => void;
    const asked = new Promise<void>((resolve) => (ask = resolve));
    const running = context.execute({
      checkpointIntervalMs: 100,
      async checkpoint(_sequence, signal) {
        await Promise.race([
          asked,
          new Promise((_, reject) => signal.addEventListener("abort", reject)),
        ]);
      },
    });
    await context.until(() => context.events().includes(WORKING));
    const commit = await context.commit("contract.ts", "export type Finding = {};\n");
    await context.until(() => context.checkpoints().length === 1);
    ask();
    await running;
    expect(context.checkpoints()).toEqual([
      { type: "checkpoint", reason: "interval", sha: commit },
      { type: "checkpoint", reason: "stop", sha: commit },
    ]);
  },
);

test.skipIf(!linux)(
  "a worktree back at the base after a checkpoint replaces it, so a restart does not bring back discarded edits",
  async () => {
    const context = await fixture();
    const stop = new AbortController();
    const running = context.execute({ signal: stop.signal, checkpointIntervalMs: 100 });
    await context.until(() => context.events().includes(WORKING));
    writeFileSync(join(context.checkout, "draft.ts"), "throwaway\n");
    await context.until(() => context.checkpoints().length === 1);
    rmSync(join(context.checkout, "draft.ts"));
    await context.until(() => context.checkpoints().length === 2);
    // Unchanged since: nothing more.
    await delay(350);
    stop.abort();
    await running;
    const [dirty, restored] = context.checkpoints();
    expect(dirty).toMatchObject({ reason: "interval" });
    expect(restored).toMatchObject({ reason: "interval" });
    expect(context.checkpoints()).toHaveLength(2);
    expect(restored!.sha).not.toBe(context.baseSha);
    const clone = await context.published(restored!.sha!);
    expect((await git(["-C", clone, "rev-parse", "HEAD^"])).trim()).toBe(context.baseSha);
    expect((await git(["-C", clone, "rev-parse", "HEAD^{tree}"])).trim()).toBe(
      (await git(["-C", clone, "rev-parse", `${context.baseSha}^{tree}`])).trim(),
    );
    expect(existsSync(join(clone, "draft.ts"))).toBe(false);
  },
);
