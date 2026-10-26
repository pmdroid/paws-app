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
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { git } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand, HANDOVER_COMMIT_MESSAGE } from "../src/runner-worker";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const EXECUTION = "01J00000000000000000000001";
const SESSION = "4f1c2a3b-claude-session";

async function fixture(agent: "claude" | "codex" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "paws-handover-worker-"));
  roots.push(root);
  const source = join(root, "source");
  const home = join(root, "home");
  const workRoot = join(root, "work");
  const output = join(root, "output", EXECUTION);
  for (const path of [source, home, output]) mkdirSync(path, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
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
    generation: 4,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    profile: { agent, model: "fixture-model" },
    repository: {
      owner: "acme",
      repo: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
      baseSha,
    },
    prompt: "Implement the request",
  };
  const checkout = join(workRoot, runId);
  const project = join(home, ".claude", "projects", checkout.replace(/[^a-zA-Z0-9]/g, "-"));
  const events = () =>
    existsSync(join(output, "events.jsonl"))
      ? readFileSync(join(output, "events.jsonl"), "utf8")
      : "";
  const until = async (marker: string, signal: AbortSignal) => {
    while (!events().includes(marker)) await delay(10, undefined, { signal });
  };
  /**
   * Paws asks for one handover once the worker's journal holds `marker`, with `limitMs` to
   * finish it; it never asks again.
   */
  const requestWhen =
    (marker: string, limitMs = 120_000) =>
    async (sequence: number, signal: AbortSignal) => {
      if (sequence > 1) await new Promise((_, reject) => signal.addEventListener("abort", reject));
      await until(marker, signal);
      return { deadline: Date.now() + limitMs };
    };
  async function execute(
    steps: FakeScript["steps"],
    extra: Partial<Parameters<typeof executeRunnerCommand>[0]> = {},
    /** Steps for the agent's next spawns, after `steps`. */
    later: FakeScript["steps"][] = [],
  ) {
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({
        model: "fixture-model",
        sessionId: SESSION,
        steps,
        ...(later.length ? { sessions: [steps, ...later] } : {}),
      }),
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
  const sessionFile: FakeScript["steps"][number] = {
    type: "write_file",
    path: join(project, `${SESSION}.jsonl`),
    content: '{"type":"user"}\n',
  };
  const toolCall = (status: "in_progress" | "completed", delayMs?: number) => ({
    type: "update" as const,
    update:
      status === "in_progress"
        ? {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Run the tests",
            kind: "execute",
            status,
          }
        : { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status },
    ...(delayMs ? { delayMs } : {}),
  });
  /** What the clone of the WIP commit holds, read from the published candidate bundle. */
  async function published(sha: string) {
    const clone = join(root, "published");
    // The bundle leaves out the base, which Paws already holds.
    await git(["clone", "-q", source, clone]);
    await git(["-C", clone, "fetch", "-q", join(output, "candidate.bundle"), "HEAD"]);
    await git(["-C", clone, "checkout", "-q", "FETCH_HEAD"]);
    expect((await git(["-C", clone, "rev-parse", "HEAD"])).trim()).toBe(sha);
    return clone;
  }
  return {
    root,
    output,
    checkout,
    baseSha,
    execute,
    events,
    requestWhen,
    until,
    sessionFile,
    toolCall,
    published,
  };
}

test.skipIf(!linux)(
  "a handover waits for the running tool call, then publishes a WIP commit of the worktree and the Claude session",
  async () => {
    const context = await fixture();
    const result = await context.execute(
      [
        context.sessionFile,
        { type: "write_file", path: join(context.checkout, "started.txt"), content: "started\n" },
        context.toolCall("in_progress", 400),
        // Written while the tool call runs, after Paws asked for the handover.
        { type: "write_file", path: join(context.checkout, "tool.txt"), content: "tool output\n" },
        context.toolCall("completed"),
        { type: "hang" },
      ],
      { handover: context.requestWhen('"toolCallId":"tool-1"') },
    );
    expect(result.run).toMatchObject({
      handedOver: true,
      cancelled: false,
      agentExited: true,
      stopReason: "cancelled",
    });
    const sha = result.candidateSha!;
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(sha).not.toBe(context.baseSha);
    // The WIP commit is exactly the runner's worktree: nothing is left uncommitted.
    expect((await git(["-C", context.checkout, "rev-parse", "HEAD"])).trim()).toBe(sha);
    expect((await git(["-C", context.checkout, "status", "--porcelain"])).trim()).toBe("");
    expect((await git(["-C", context.checkout, "log", "-1", "--format=%s"])).trim()).toBe(
      HANDOVER_COMMIT_MESSAGE,
    );
    const clone = await context.published(sha);
    expect(readFileSync(join(clone, "started.txt"), "utf8")).toBe("started\n");
    expect(readFileSync(join(clone, "tool.txt"), "utf8")).toBe("tool output\n");
    expect((await git(["-C", clone, "diff", "--stat", sha])).trim()).toBe("");
    // The same snapshot a turn end takes, with the WIP commit and the turn.
    const metadata = JSON.parse(readFileSync(join(context.output, "session.json"), "utf8"));
    expect(metadata).toMatchObject({
      agent: "claude",
      sessionId: SESSION,
      workspacePath: context.checkout,
      commitSha: sha,
      turn: 4,
    });
    const bundle = gunzipSync(readFileSync(join(context.output, "session.ndjson.gz")))
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { path: string });
    expect(bundle.map((entry) => entry.path)).toEqual([
      expect.stringMatching(new RegExp(`/${SESSION}\\.jsonl$`)),
    ]);
    expect(context.events()).toContain('{"type":"handover","handedOver":true}');
    expect(context.events()).not.toContain('"handedOver":false');
  },
);

test.skipIf(!linux)(
  "an agent without session snapshots hands over with the WIP commit only",
  async () => {
    const context = await fixture("codex");
    const result = await context.execute(
      [
        { type: "write_file", path: join(context.checkout, "work.txt"), content: "work\n" },
        context.toolCall("in_progress", 100),
        context.toolCall("completed"),
        { type: "hang" },
      ],
      { handover: context.requestWhen('"toolCallId":"tool-1"') },
    );
    expect(result.run.handedOver).toBe(true);
    const clone = await context.published(result.candidateSha!);
    expect(readFileSync(join(clone, "work.txt"), "utf8")).toBe("work\n");
    expect(existsSync(join(context.output, "session.json"))).toBe(false);
    expect(existsSync(join(context.output, "session.ndjson.gz"))).toBe(false);
  },
);

test.skipIf(!linux)(
  "a handover with no safe point in time is reported and the session keeps running",
  async () => {
    const context = await fixture();
    const result = await context.execute(
      [
        context.sessionFile,
        context.toolCall("in_progress", 800),
        context.toolCall("completed"),
        { type: "write_file", path: join(context.checkout, "done.txt"), content: "done\n" },
        { type: "end" },
      ],
      { handover: context.requestWhen('"toolCallId":"tool-1"', 150), handoverReserveMs: 0 },
    );
    expect(context.events()).toContain('{"type":"handover","handedOver":false,"reason":"timeout"}');
    // The agent finished its turn on this runner, as if no handover had been asked for.
    expect(result.run.handedOver).toBeUndefined();
    expect(result.run.stopReason).toBe("end_turn");
    expect(result.run.cancelled).toBe(false);
    const clone = await context.published(result.candidateSha!);
    expect(readFileSync(join(clone, "done.txt"), "utf8")).toBe("done\n");
  },
);

test.skipIf(!linux)(
  "a session waiting on ask_team hands over without waiting for the answer, and its question is published",
  async () => {
    const context = await fixture();
    const result = await context.execute(
      [
        context.sessionFile,
        { type: "write_file", path: join(context.checkout, "draft.txt"), content: "draft\n" },
        {
          type: "update",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "ask-1",
            title: "ask_team",
            kind: "other",
            status: "in_progress",
          },
        },
        { type: "ask_team", question: "Which color should the button be?" },
        { type: "hang" },
      ],
      {
        handover: context.requestWhen('"type":"question"'),
        // Paws answers the Closeout policy request; nobody answers the question.
        answer: (requestId, signal) =>
          context.events().includes(`{"type":"closeout_policy","requestId":"${requestId}"}`)
            ? Promise.resolve({ answer: "{}" })
            : new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
              ),
      },
    );
    expect(result.run.handedOver).toBe(true);
    const questions = context
      .events()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; question?: string })
      .filter((event) => event.type === "question");
    expect(questions.map((event) => event.question)).toEqual(["Which color should the button be?"]);
    const clone = await context.published(result.candidateSha!);
    expect(readFileSync(join(clone, "draft.txt"), "utf8")).toBe("draft\n");
    const metadata = JSON.parse(readFileSync(join(context.output, "session.json"), "utf8"));
    expect(metadata.commitSha).toBe(result.candidateSha);
  },
);

const TIMED_OUT = '{"type":"handover","handedOver":false,"reason":"timeout"}';

test.skipIf(!linux)(
  "a tool call running beside a waiting ask_team question holds the handover until it finishes",
  async () => {
    const context = await fixture();
    const result = await context.execute(
      [
        context.sessionFile,
        context.toolCall("in_progress"),
        { type: "ask_team", question: "Which color should the button be?" },
        context.toolCall("completed"),
        { type: "end" },
      ],
      {
        handover: context.requestWhen('"type":"question"', 300),
        handoverReserveMs: 0,
        // The question is answered once the handover gave up, so the turn can end.
        answer: async (requestId, signal) => {
          if (context.events().includes(`{"type":"closeout_policy","requestId":"${requestId}"}`))
            return { answer: "{}" };
          await context.until(TIMED_OUT, signal);
          return { answer: "Blue" };
        },
      },
    );
    expect(context.events()).toContain(TIMED_OUT);
    expect(result.run.handedOver).toBeUndefined();
    expect(result.run.stopReason).toBe("end_turn");
  },
);

test.skipIf(!linux)("Paws can ask again after a handover timed out", async () => {
  const context = await fixture();
  const result = await context.execute(
    [
      context.sessionFile,
      { type: "write_file", path: join(context.checkout, "work.txt"), content: "work\n" },
      context.toolCall("in_progress", 800),
      context.toolCall("completed"),
      { type: "hang" },
    ],
    {
      handoverReserveMs: 0,
      async handover(sequence, signal) {
        if (sequence === 1) {
          await context.until('"toolCallId":"tool-1"', signal);
          return { deadline: Date.now() + 150 };
        }
        await context.until(TIMED_OUT, signal);
        return { deadline: Date.now() + 120_000 };
      },
    },
  );
  expect(context.events()).toContain(TIMED_OUT);
  expect(result.run.handedOver).toBe(true);
  const clone = await context.published(result.candidateSha!);
  expect(readFileSync(join(clone, "work.txt"), "utf8")).toBe("work\n");
  expect(existsSync(join(context.output, "session.json"))).toBe(true);
});

for (const [cause, reason, steps, limitMs] of [
  // The deadline passes while the agent stops and the WIP commit and snapshot are made.
  ["reaches its deadline after the interrupt", "timeout", true, 50],
  // Claude left no session file to save.
  ["cannot save the Claude session", "snapshot", false, 120_000],
] as const)
  test.skipIf(!linux)(
    `a handover that ${cause} is reported, and the session goes on on the runner from the WIP commit`,
    async () => {
      const context = await fixture();
      const result = await context.execute(
        [
          ...(steps ? [context.sessionFile] : []),
          { type: "write_file", path: join(context.checkout, "work.txt"), content: "work\n" },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "thinking" },
            },
          },
          { type: "hang" },
        ],
        { handover: context.requestWhen('"thinking"', limitMs), handoverReserveMs: 0 },
        [
          [
            { type: "write_file", path: join(context.checkout, "done.txt"), content: "done\n" },
            { type: "end" },
          ],
        ],
      );
      expect(context.events()).toContain(
        `{"type":"handover","handedOver":false,"reason":"${reason}"}`,
      );
      expect(context.events()).not.toContain('"handedOver":true');
      // The session went on here and finished its turn; nothing was handed over.
      expect(result.run.handedOver).toBeUndefined();
      expect(result.run.stopReason).toBe("end_turn");
      const clone = await context.published(result.candidateSha!);
      expect(readFileSync(join(clone, "work.txt"), "utf8")).toBe("work\n");
      expect(readFileSync(join(clone, "done.txt"), "utf8")).toBe("done\n");
      expect(await git(["-C", clone, "log", "--format=%s"])).toContain(HANDOVER_COMMIT_MESSAGE);
      const trace = JSON.parse(readFileSync(join(context.root, "trace.json"), "utf8")) as {
        prompts: unknown[];
      };
      expect(JSON.stringify(trace.prompts.at(-1))).toContain("could not finish in time");
    },
  );
