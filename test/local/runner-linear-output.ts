import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openExecutionJournal, type WorkCommand } from "../../src/runner-journal";
import { createAcpActivityReporter } from "../../src/loop";
import { createLinearClient, createLinearTracker, type ProgressUpdate } from "../../src/linear";

export async function probeRunnerLinearOutput(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "journal"), { mode: 0o700 });
  let journal = openExecutionJournal(join(root, "journal"));
  const command: WorkCommand = {
    id: "command",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1000,
    expiresAt: 61000,
    runId: "run",
    itemId: "item",
    generation: 1,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "codex", model: null },
    prompt: "Inspect source",
  };
  const execution = journal.admit(command, 1000)!;
  const output =
    "First output line\n" + "`".repeat(1000) + "\n" + "x".repeat(12_000) + "\nLast output line";
  const updates = [
    {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "Run checks",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun test" },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      _meta: { terminal_output_delta: { data: output.slice(0, 4000) } },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool",
      _meta: { terminal_output_delta: { data: output.slice(4000) } },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" },
    {
      sessionUpdate: "tool_call",
      toolCallId: "failed",
      title: "Read file",
      status: "failed",
      rawOutput: "File unavailable. token=private-value",
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "private",
      title: "Private reasoning",
      kind: "think",
      status: "completed",
      rawOutput: "hidden-reasoning",
    },
  ];
  const permissions = [
    {
      toolCallId: "closeout",
      decision: "allow",
      reason: "allowed",
      title: "mcp__paws__run_closeout",
      kind: "other",
    },
    {
      toolCallId: "script",
      decision: "allow",
      reason: "allowed",
      title: "python3 - <<'EOF'\nprint(1)\nEOF",
      kind: "execute",
    },
  ];
  journal.ingest(
    execution.id,
    Buffer.from(
      [
        ...updates.map((update) => ({ type: "acp", event: { type: "session_update", update } })),
        ...permissions.map((permission) => ({
          type: "acp",
          event: { type: "permission", ...permission },
        })),
      ]
        .map((line) => JSON.stringify(line) + "\n")
        .join(""),
    ),
  );
  journal.close();
  journal = openExecutionJournal(join(root, "journal"));
  const published: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => published.push(activity));
  const rows = journal.pending(execution.id);
  assert.equal(rows.filter((row) => row.event.type === "permission").length, permissions.length);
  for (const row of rows) {
    if (row.event.type === "activity")
      reporter.onEvent({ type: "session_update", sessionId: command.id, update: row.event.update });
    if (row.event.type === "permission")
      reporter.onEvent({ type: "permission", ...row.event.permission });
  }
  reporter.flush();
  const received: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { variables } = (await request.json()) as {
        variables: { input: Record<string, unknown> };
      };
      received.push(variables.input);
      return Response.json({
        data: {
          agentActivityCreate: { success: true, agentActivity: { id: variables.input["id"] } },
        },
      });
    },
  });
  const tracker = createLinearTracker(
    createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: async () => "fixture",
        forceRefresh: async () => "fixture",
      },
      fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}/graphql`, init),
    }),
  );
  try {
    for (const activity of published)
      await tracker.createActivity({ ...activity, sessionId: "session", id: randomUUID() });
    const visible = received.flatMap((activity) => {
      const content = activity["content"] as { type: string; body?: string };
      return content.type === "thought" ? [content.body!] : [];
    });
    assert(visible.every((body) => !body.startsWith("Tool output:")));
    assert(!JSON.stringify(received).includes(output.slice(0, 200)));
    assert(!JSON.stringify(received).includes("File unavailable."));
    assert(
      received.every((activity) => (activity["content"] as { type: string }).type !== "action"),
    );
    assert(published.every((activity) => !activity.ephemeral && activity.body.length <= 3500));
    assert(!JSON.stringify(received).includes("private-value"));
    assert(!JSON.stringify(received).includes("hidden-reasoning"));
    assert(!JSON.stringify(received).includes("mcp__paws__run_closeout"));
    assert(!JSON.stringify(received).includes("python3"));
    const observations = {
      passed: true,
      journalReopened: true,
      realHttpActivities: received.length,
      toolOutputHidden: true,
      secretsAndReasoningHidden: true,
    };
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
    return observations;
  } finally {
    server.stop(true);
    journal.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Pass a disposable evidence directory");
  console.log(JSON.stringify(await probeRunnerLinearOutput(root)));
}
