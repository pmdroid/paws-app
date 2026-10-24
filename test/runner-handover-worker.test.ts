import { expect, test } from "bun:test";
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
import { publishRunnerHandover, readRunnerHandover } from "../src/runner-answers";
import {
  publishRunnerJob,
  readRunnerJobInputs,
  type RunnerJob,
  type RunnerSpool,
} from "../src/runner-execution";
import {
  executeRunnerCommand,
  HANDOVER_RESULT,
  HANDOVER_RESUME_PROMPT,
  HANDOVER_TIMEOUT_NOTICE,
  type RunnerWorkerOptions,
} from "../src/runner-worker";

/** Resolves a handover request once the agent has written `file`, so a tool call is in flight. */
async function inFlight(name: string, file: string, signal: AbortSignal) {
  const checkout = join(roots.get(name)!, "work", "01J00000000000000000000009", file);
  while (!existsSync(checkout)) await delay(10, undefined, { signal });
  await delay(100, undefined, { signal });
  return { expiresAt: Date.now() + 120_000 };
}
const roots = new Map<string, string>();
const spools = new Map<string, RunnerSpool>();
const EXECUTION = "01J00000000000000000000009";

const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

async function handoverFixture(
  name: string,
  steps: (checkout: string) => unknown[],
  extra: Partial<RunnerWorkerOptions>,
) {
  const root = mkdtempSync(join(tmpdir(), `paws-handover-${name}-`));
  roots.set(name, root);
  const source = join(root, "source");
  const workRoot = join(root, "work");
  const outputDirectory = join(root, "output");
  for (const path of [source, join(root, "home"), workRoot, outputDirectory])
    mkdirSync(path, { recursive: true });
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
  const job: RunnerJob = {
    executionId: "01J00000000000000000000009",
    command: {
      type: "run",
      id: "cmd",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
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
      prompt: "Implement",
      checkpointBot: { appId: "99", login: "paws-test[bot]", id: 88 },
    },
  };
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  spools.set(name, spool);
  mkdirSync(spool.root);
  chmodSync(spool.root, 0o750);
  publishRunnerJob(spool, job, { repositoryBundle });
  const checkout = join(workRoot, job.executionId);
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: steps(checkout) }));
  const result = await executeRunnerCommand({
    job,
    repositoryBundle,
    inputs: readRunnerJobInputs(spool, job.executionId),
    outputDirectory,
    workRoot,
    home: join(root, "home"),
    resultsGid: process.getgid!(),
    launch: { command: process.execPath, args: [fake, join(root, "trace.json"), script] },
    ...extra,
  });
  const events = readFileSync(join(outputDirectory, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; text?: string; question?: string });
  return {
    result,
    baseSha,
    checkout,
    outputDirectory,
    events,
    /** Restarts the worker on its session, as the runner does after a missed handover. */
    async resume(resumeSteps: unknown[], resumeExtra: Partial<RunnerWorkerOptions> = {}) {
      const resumeScript = join(root, "resume.json");
      writeFileSync(resumeScript, JSON.stringify({ model: "fixture-model", steps: resumeSteps }));
      return executeRunnerCommand({
        job,
        repositoryBundle,
        inputs: readRunnerJobInputs(spool, job.executionId),
        outputDirectory,
        workRoot,
        home: join(root, "home"),
        resultsGid: process.getgid!(),
        resume: true,
        launch: {
          command: process.execPath,
          args: [fake, join(root, "resume-trace.json"), resumeScript],
        },
        ...resumeExtra,
      });
    },
    trace: (file: string) =>
      JSON.parse(readFileSync(join(root, file), "utf8")) as { prompts?: unknown[] },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a handover waits for the current tool call, then publishes the worktree as a WIP commit", async () => {
  const f = await handoverFixture(
    "tool",
    (checkout) => [
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit",
          title: "Edit",
          status: "in_progress",
        },
      },
      { type: "fs_write", path: join(checkout, "partial.txt"), content: "half done\n" },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "in_progress" },
        delayMs: 400,
      },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
      },
      { type: "hang" },
    ],
    {
      // The runner publishes the request in the spool, where the worker reads it.
      async handover(sequence, signal) {
        const spool = spools.get("tool")!;
        if (sequence === 1) {
          const { expiresAt } = await inFlight("tool", "partial.txt", signal);
          publishRunnerHandover(spool, EXECUTION, 1, expiresAt);
          publishRunnerHandover(spool, EXECUTION, 1, expiresAt);
        }
        for (;;) {
          const request = readRunnerHandover(spool, EXECUTION, sequence);
          if (request) return request;
          await delay(10, undefined, { signal });
        }
      },
    },
  );
  try {
    const { result } = f;
    expect(result.run.handedOver).toBe(true);
    expect(result.run.cancelled).toBe(true);
    expect(result.run.agentExited).toBe(true);
    expect(result.candidateSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.candidateSha).not.toBe(f.baseSha);
    expect((await git(["-C", f.checkout, "rev-parse", "HEAD"])).trim()).toBe(result.candidateSha!);
    expect((await git(["-C", f.checkout, "status", "--porcelain"])).trim()).toBe("");
    expect(
      (await git(["-C", f.checkout, "show", "--name-only", "--format=%s", result.candidateSha!]))
        .trim()
        .split("\n"),
    ).toEqual(["wip: handover checkpoint", "", "partial.txt"]);
    expect(existsSync(join(f.outputDirectory, "candidate.bundle"))).toBe(true);
    // The result waits as a handover result, with the deadline the runner must publish by.
    expect(existsSync(join(f.outputDirectory, "result.json"))).toBe(false);
    const waiting = JSON.parse(readFileSync(join(f.outputDirectory, HANDOVER_RESULT), "utf8"));
    expect(waiting.handoverExpiresAt).toBe(result.handoverExpiresAt);
    expect(waiting.handoverExpiresAt).toBeGreaterThan(Date.now());
    const transcript = readFileSync(result.run.transcriptPath!, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          (JSON.parse(line) as { event: { type: string; update?: { status?: string } } }).event,
      );
    const completed = transcript.findIndex((event) => event.update?.status === "completed");
    const cancelled = transcript.findIndex((event) => event.type === "cancelled");
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(cancelled).toBeGreaterThan(completed);
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a session waiting on ask_team hands over and keeps its question with Paws", async () => {
  const question = { asked: false };
  const f = await handoverFixture(
    "ask",
    (checkout) => [
      { type: "fs_write", path: join(checkout, "partial.txt"), content: "before the question\n" },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "question",
          title: "mcp__paws__ask_team",
          status: "in_progress",
        },
      },
      { type: "ask_team", question: "Include archived rows?" },
      { type: "hang" },
    ],
    {
      async answer(_requestId, signal) {
        // Only the question waits; later requests, like the Closeout policy, get an answer.
        if (question.asked) return { answer: "{}" };
        question.asked = true;
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        throw new Error("unreachable");
      },
      async handover(_sequence, signal) {
        while (!question.asked) await delay(10, undefined, { signal });
        return { expiresAt: Date.now() + 120_000 };
      },
    },
  );
  try {
    expect(f.result.run.handedOver).toBe(true);
    expect(
      f.events.some(
        (event) => event.type === "question" && event.question === "Include archived rows?",
      ),
    ).toBe(true);
    expect(f.result.candidateSha).toMatch(/^[a-f0-9]{40}$/);
    expect(readFileSync(join(f.checkout, "partial.txt"), "utf8")).toBe("before the question\n");
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a handover that cannot reach a safe point in time is reported and the session continues", async () => {
  let requests = 0;
  const f = await handoverFixture(
    "timeout",
    (checkout) => [
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "build",
          title: "Build",
          status: "in_progress",
        },
      },
      { type: "fs_write", path: join(checkout, "marker.txt"), content: "building\n" },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "build", status: "in_progress" },
        delayMs: 500,
      },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "build", status: "completed" },
      },
      { type: "fs_write", path: join(checkout, "done.txt"), content: "done\n" },
      { type: "end" },
    ],
    {
      // The clock runs past the safe point at once, while the request itself is still current.
      now: () => Date.now() + 100_000,
      async handover(sequence, signal) {
        if (sequence > 1) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          signal.throwIfAborted();
        }
        requests++;
        return inFlight("timeout", "marker.txt", signal);
      },
    },
  );
  try {
    expect(requests).toBe(1);
    expect(f.result.run.handedOver).toBeUndefined();
    expect(f.result.run.stopReason).toBe("end_turn");
    expect(
      f.events.some((event) => event.type === "progress" && event.text === HANDOVER_TIMEOUT_NOTICE),
    ).toBe(true);
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a question asked while another tool call runs does not let the handover interrupt that call", async () => {
  const question = { asked: false, release: () => {} };
  const released = new Promise<void>((resolve) => (question.release = resolve));
  let requests = 0;
  const f = await handoverFixture(
    "parallel",
    () => [
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit",
          title: "Edit",
          status: "in_progress",
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "question",
          title: "mcp__paws__ask_team",
          status: "in_progress",
        },
      },
      { type: "ask_team", question: "Keep the old column?" },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "question", status: "completed" },
      },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
      },
      { type: "end" },
    ],
    {
      // The clock runs past the safe point at once, so the busy edit makes the handover give up.
      now: () => Date.now() + 100_000,
      async answer(_requestId, signal) {
        if (question.asked) return { answer: "{}" };
        question.asked = true;
        await released;
        signal.throwIfAborted();
        return { answer: "Yes" };
      },
      async handover(sequence, signal) {
        if (sequence > 1) {
          question.release();
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          signal.throwIfAborted();
        }
        while (!question.asked) await delay(10, undefined, { signal });
        requests++;
        return { expiresAt: Date.now() + 120_000 };
      },
    },
  );
  try {
    expect(requests).toBe(1);
    expect(f.result.run.handedOver).toBeUndefined();
    expect(f.result.run.stopReason).toBe("end_turn");
    expect(
      f.events.some((event) => event.type === "progress" && event.text === HANDOVER_TIMEOUT_NOTICE),
    ).toBe(true);
  } finally {
    f.cleanup();
  }
}, 20_000);

test("a worker restarted after a missed handover continues the session on the runner", async () => {
  const f = await handoverFixture(
    "resume",
    (checkout) => [
      {
        type: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit",
          title: "Edit",
          status: "in_progress",
        },
      },
      { type: "fs_write", path: join(checkout, "partial.txt"), content: "half done\n" },
      {
        type: "update",
        update: { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
      },
      { type: "hang" },
    ],
    { handover: (_sequence, signal) => inFlight("resume", "partial.txt", signal) },
  );
  try {
    expect(f.result.run.handedOver).toBe(true);
    expect(f.result.handoverSequence).toBe(1);
    // The answered request stays in the spool and has time left; the restarted worker skips it.
    const asked: number[] = [];
    const request = { expiresAt: Date.now() + 120_000 };
    const resumed = await f.resume(
      [
        { type: "fs_write", path: join(f.checkout, "rest.txt"), content: "rest\n" },
        { type: "end" },
      ],
      {
        async handover(sequence, signal) {
          asked.push(sequence);
          if (sequence === 1) return request;
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          signal.throwIfAborted();
          return request;
        },
      },
    );
    expect(asked).toEqual([2]);
    expect(resumed.run.handedOver).toBeUndefined();
    expect(resumed.run.stopReason).toBe("end_turn");
    expect(existsSync(join(f.outputDirectory, HANDOVER_RESULT))).toBe(false);
    expect(existsSync(join(f.outputDirectory, "result.json"))).toBe(true);
    expect(JSON.stringify(f.trace("resume-trace.json").prompts)).toContain(
      HANDOVER_RESUME_PROMPT.slice(0, 60),
    );
    // The resumed candidate builds on the WIP commit.
    expect(
      (await git(["-C", f.checkout, "log", "--format=%s", "-2", resumed.candidateSha!]))
        .trim()
        .split("\n")[1],
    ).toBe("wip: handover checkpoint");
    const events = readFileSync(join(f.outputDirectory, "events.jsonl"), "utf8");
    expect(events).toContain(HANDOVER_TIMEOUT_NOTICE);
  } finally {
    f.cleanup();
  }
}, 30_000);
