import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import { fileURLToPath } from "node:url";
import type { FakeScript } from "../src/acp/testing/script";
import { RunnerHelperResultSchema, type RunnerCommand } from "../src/runner-protocol";
import { CONVERSATION_RESULT_MARGIN_MS, executeRunnerCommand } from "../src/runner-worker";

const env = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Acme",
  GIT_AUTHOR_EMAIL: "dev@acme.test",
  GIT_COMMITTER_NAME: "Acme",
  GIT_COMMITTER_EMAIL: "dev@acme.test",
};

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, env });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

type Fixture = { root: string; checkout: string; session: string };

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-helper-"));
  const checkout = join(root, "work", "run-acme-1");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "paws/acme-checkout");
  writeFileSync(
    join(checkout, "README.md"),
    "# acme/web\n\nThe checkout page takes card payments.\n",
  );
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "Add the acme checkout page");
  const session = join(root, "home", ".claude", "projects", "run-acme-1", "session-acme.jsonl");
  mkdirSync(join(session, ".."), { recursive: true });
  writeFileSync(session, '{"type":"user","message":"Build the acme checkout page"}\n');
  mkdirSync(join(root, "output"));
  return { root, checkout, session };
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const created = createFixture();
  try {
    await body(created);
  } finally {
    rmSync(created.root, { recursive: true, force: true });
  }
}

function command(lifetime = 900_000): Extract<RunnerCommand, { type: "helper" }> {
  const now = Date.now();
  return {
    id: randomUUID(),
    type: "helper",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + lifetime,
    sessionId: "linear-session",
    sessionGeneration: 1,
    purpose: "conversation",
    profile: { agent: "claude", model: "fixture-model" },
    prompt: "What does the acme checkout page do?",
    conversation: { itemId: "item-acme", runId: "run-acme-1", resumeSessionId: "session-acme" },
  };
}

async function converse(
  { root, session }: Fixture,
  input: ReturnType<typeof command>,
  script: Omit<FakeScript, "loadFile">,
) {
  const scriptPath = join(root, "script.json");
  const recorded = join(root, "agent.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({ model: "fixture-model", loadSession: true, loadFile: session, ...script }),
  );
  const result = await executeRunnerCommand({
    job: { executionId: "0".repeat(26), command: input },
    outputDirectory: join(root, "output"),
    workRoot: join(root, "work"),
    home: join(root, "home"),
    resultsGid: process.getgid!(),
    launch: {
      command: process.execPath,
      args: [
        "--no-env-file",
        fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
        recorded,
        scriptPath,
      ],
      env: { PATH: "/usr/bin:/bin" },
    },
  });
  const saved = JSON.parse(readFileSync(join(root, "output", "result.json"), "utf8"));
  const published = RunnerHelperResultSchema.parse({
    ...saved.run,
    executionId: saved.executionId,
    commandId: saved.commandId,
    text: saved.text,
    ...(saved.replies ? { replies: saved.replies } : {}),
    ...(saved.startWork ? { startWork: saved.startWork } : {}),
  });
  return { result, published, calls: JSON.parse(readFileSync(recorded, "utf8")) };
}

const chunk = (text: string) => ({
  type: "update" as const,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

test(
  "a conversation helper resumes the item's session in its checkout and answers with reply",
  () =>
    withFixture(async (fixture) => {
      const { root, checkout } = fixture;
      const head = git(checkout, "rev-parse", "HEAD");
      const { result, published, calls } = await converse(fixture, command(), {
        steps: [
          { type: "fs_read", path: join(checkout, "README.md") },
          { type: "fs_write", path: join(checkout, "README.md"), content: "# changed\n" },
          { type: "terminal", command: "git", args: ["commit", "-am", "Edit acme"], cwd: checkout },
          {
            type: "permission",
            toolCall: {
              toolCallId: "edit-readme",
              kind: "edit",
              locations: [{ path: join(checkout, "README.md") }],
            },
          },
          {
            type: "permission",
            toolCall: {
              toolCallId: "push",
              kind: "execute",
              rawInput: { command: "git push origin HEAD" },
            },
          },
          { type: "reply", text: "The acme checkout page takes card payments." },
          chunk("I answered in the thread."),
          { type: "end" },
        ],
      });

      expect(calls.loaded.sessionId).toBe("session-acme");
      expect(calls.loaded.cwd).toBe(checkout);
      expect(calls.loadedFile).toContain("Build the acme checkout page");
      expect(calls.methods).not.toContain("session/new");
      expect(JSON.stringify(calls.prompts)).toContain("What does the acme checkout page do?");
      expect(result.run.sessionId).toBe("session-acme");

      expect(calls.fs[0]).toMatchObject({ op: "read", ok: true });
      expect(calls.fs[1]).toMatchObject({ op: "write", ok: false });
      expect(calls.terminals[0].ok).toBe(false);
      expect(calls.permissions.map((entry: { outcome: unknown }) => entry.outcome)).toEqual([
        { outcome: { outcome: "selected", optionId: "deny" } },
        { outcome: { outcome: "selected", optionId: "deny" } },
      ]);
      expect(readFileSync(join(checkout, "README.md"), "utf8")).toContain("card payments");
      expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
      expect(git(checkout, "status", "--porcelain")).toBe("");

      const tools = calls.mcpServers[0].env
        .find((entry: { name: string }) => entry.name === "PAWS_HOST_TOOLS")
        .value.split(",");
      expect(tools).toContain("reply");
      expect(tools).toContain("start_work");
      for (const tool of ["ask_team", "run_closeout", "open_pull_request", "publish_artifact"])
        expect(tools).not.toContain(tool);
      expect(calls.updates).toEqual([{ ok: true, text: expect.any(String) }]);
      expect(published.replies).toEqual(["The acme checkout page takes card payments."]);
      expect(published.text).toBe("I answered in the thread.");
      expect(published.stopReason).toBe("end_turn");
      const events = readFileSync(join(root, "output", "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; text?: string });
      expect(events.filter((event) => event.type === "reply")).toEqual([
        expect.objectContaining({ text: "The acme checkout page takes card payments." }),
      ]);
    }),
  15_000,
);

test(
  "a conversation helper with no reply returns its final message",
  () =>
    withFixture(async (fixture) => {
      const { published } = await converse(fixture, command(), {
        steps: [
          chunk("Let me read the checkout."),
          {
            type: "update",
            update: { sessionUpdate: "tool_call", toolCallId: "read", title: "Read", kind: "read" },
          },
          chunk("The acme checkout page "),
          chunk("takes card payments."),
          { type: "end" },
        ],
      });

      expect(published.replies).toBeUndefined();
      expect(published.text).toBe("The acme checkout page takes card payments.");
    }),
  15_000,
);

test(
  "a conversation helper stops at its lifetime, keeps the session and says it timed out",
  () =>
    withFixture(async (fixture) => {
      const { published } = await converse(fixture, command(CONVERSATION_RESULT_MARGIN_MS + 500), {
        steps: [chunk("Still reading the acme checkout."), { type: "hang" }],
      });

      expect(published.timedOut).toBe(true);
      expect(published.stopReason).toBe("timeout");
      expect(published.sessionId).toBe("session-acme");
      expect(published.agentExited).toBe(true);
      expect(published.text).toBe("Still reading the acme checkout.");
      expect(existsSync(fixture.session)).toBe(true);
    }),
  15_000,
);

test(
  "a conversation helper's lifetime covers agent startup and session loading",
  () =>
    withFixture(async (fixture) => {
      const { published } = await converse(fixture, command(CONVERSATION_RESULT_MARGIN_MS + 500), {
        hangInitialize: true,
        steps: [{ type: "end" }],
      });

      expect(published.timedOut).toBe(true);
      expect(published.stopReason).toBe("timeout");
      expect(published.agentExited).toBe(true);
      expect(existsSync(fixture.session)).toBe(true);
    }),
  15_000,
);

test("a conversation helper refuses to start without the item's checkout", () =>
  withFixture(async (fixture) => {
    rmSync(fixture.checkout, { recursive: true, force: true });
    await expect(converse(fixture, command(), { steps: [{ type: "end" }] })).rejects.toThrow(
      "The item's checkout is not on this runner",
    );
    expect(existsSync(fixture.checkout)).toBe(false);
  }));

const PLAN = "Add a test that the acme checkout retries a card once on a gateway timeout.";
const hostTools = (calls: { mcpServers: { env: { name: string; value: string }[] }[] }) =>
  calls.mcpServers[0]!.env.find((entry) => entry.name === "PAWS_HOST_TOOLS")!.value.split(",");

test(
  "start_work ends the conversation turn with its plan and keeps the session",
  () =>
    withFixture(async (fixture) => {
      const head = git(fixture.checkout, "rev-parse", "HEAD");
      const { published, calls } = await converse(fixture, command(), {
        steps: [
          { type: "reply", text: "I will add the retry test." },
          { type: "start_work", plan: PLAN },
          chunk("Waiting for the work turn."),
          { type: "hang" },
        ],
      });

      expect(calls.updates[1]).toEqual({ ok: true, text: expect.stringContaining("Work queued") });
      expect(published).toMatchObject({
        startWork: PLAN,
        replies: ["I will add the retry test."],
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        agentExited: true,
        sessionId: "session-acme",
      });
      expect(existsSync(fixture.session)).toBe(true);
      expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(head);
      expect(git(fixture.checkout, "status", "--porcelain")).toBe("");
    }),
  15_000,
);

test(
  "Claude's permission requests for mcp__paws__reply and mcp__paws__start_work are allowed in the read-only turn",
  () =>
    withFixture(async (fixture) => {
      // The Claude adapter names an MCP tool `mcp__<server>__<tool>` and asks before each call.
      const ask = (toolCallId: string, name: string, rawInput: Record<string, string>) => ({
        type: "permission" as const,
        toolCall: { toolCallId, name, title: name, kind: "other", rawInput },
      });
      const { published, calls } = await converse(fixture, command(), {
        steps: [
          ask("reply", "mcp__paws__reply", { text: "I will add the retry test." }),
          { type: "reply", text: "I will add the retry test." },
          ask("start", "mcp__paws__start_work", { plan: PLAN }),
          { type: "start_work", plan: PLAN },
          { type: "hang" },
        ],
      });

      expect(hostTools(calls)).toEqual(expect.arrayContaining(["reply", "start_work"]));
      expect(calls.permissions.map((entry: { outcome: unknown }) => entry.outcome)).toEqual([
        { outcome: { outcome: "selected", optionId: "allow" } },
        { outcome: { outcome: "selected", optionId: "allow" } },
      ]);
      expect(JSON.stringify(calls.prompts)).toContain("at most 4,000 characters");
      expect(published).toMatchObject({
        startWork: PLAN,
        replies: ["I will add the retry test."],
        stopReason: "end_turn",
      });
    }),
  15_000,
);

test(
  "a plan over 4000 characters is refused with a message and the conversation turn goes on",
  () =>
    withFixture(async (fixture) => {
      const { published, calls } = await converse(fixture, command(), {
        steps: [
          { type: "start_work", plan: "x".repeat(4001) },
          { type: "reply", text: "The plan was too long; here is the short answer instead." },
          { type: "end" },
        ],
      });

      expect(calls.updates[0]).toEqual({
        ok: true,
        text: expect.stringContaining("Not started: plan needs 1 to 4000 characters"),
      });
      expect(published.startWork).toBeUndefined();
      expect(published.replies).toEqual([
        "The plan was too long; here is the short answer instead.",
      ]);
      expect(published.stopReason).toBe("end_turn");
    }),
  15_000,
);

test(
  "a task turn is not offered start_work",
  () =>
    withFixture(async ({ root }) => {
      const executionId = "1".repeat(26);
      const worktree = join(root, "work", executionId);
      mkdirSync(worktree, { mode: 0o770 });
      chmodSync(worktree, 0o770);
      const now = Date.now();
      const task: Extract<RunnerCommand, { type: "task" }> = {
        id: randomUUID(),
        type: "task",
        runnerId: "runner",
        workspaceId: "workspace",
        runId: "run-acme-task",
        itemId: "item-acme",
        generation: 1,
        sessionId: "linear-session",
        sessionGeneration: 1,
        taskModeGeneration: 1,
        purpose: "answer",
        issuedAt: now,
        expiresAt: now + 60_000,
        profile: { agent: "claude", model: "fixture-model" },
        prompt: "What does the acme checkout page do?",
        inputFiles: [],
      };
      const scriptPath = join(root, "task-script.json");
      const recorded = join(root, "task-agent.json");
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: "fixture-model",
          steps: [{ type: "start_work", plan: PLAN }, { type: "end" }],
        }),
      );
      await executeRunnerCommand({
        job: { executionId, command: task },
        outputDirectory: join(root, "output"),
        workRoot: join(root, "work"),
        home: join(root, "home"),
        resultsGid: process.getgid!(),
        launch: {
          command: process.execPath,
          args: [
            "--no-env-file",
            fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
            recorded,
            scriptPath,
          ],
          env: { PATH: "/usr/bin:/bin" },
        },
      });
      const calls = JSON.parse(readFileSync(recorded, "utf8"));
      expect(hostTools(calls)).not.toContain("start_work");
      expect(calls.updates[0]).toMatchObject({ ok: false });
    }),
  15_000,
);
