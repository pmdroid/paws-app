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
  journal.ingest(
    execution.id,
    Buffer.from(
      updates
        .map(
          (update) =>
            JSON.stringify({ type: "acp", event: { type: "session_update", update } }) + "\n",
        )
        .join(""),
    ),
  );
  journal.close();
  journal = openExecutionJournal(join(root, "journal"));
  const published: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => published.push(activity));
  for (const row of journal.pending(execution.id)) {
    assert.equal(row.event.type, "activity");
    if (row.event.type === "activity")
      reporter.onEvent({ type: "session_update", sessionId: command.id, update: row.event.update });
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
    const blocks = visible.filter((body) => body.startsWith("Tool output: Run checks\n"));
    const reconstructed = blocks
      .map((body) => {
        const match = /^Tool output: Run checks\n\n(`{3,})text\n([\s\S]*)\n\1$/.exec(body);
        assert(match, body);
        assert(!match[2]!.includes(match[1]!));
        return match[2]!;
      })
      .join("");
    assert.equal(reconstructed, output);
    assert(visible.some((body) => body.includes("File unavailable. token=[redacted]")));
    assert(published.every((activity) => !activity.ephemeral && activity.body.length <= 3500));
    assert(!JSON.stringify(received).includes("private-value"));
    assert(!JSON.stringify(received).includes("hidden-reasoning"));
    const actions = received.flatMap((activity) => {
      const content = activity["content"] as { type: string; result?: string };
      return content.type === "action" && content.result ? [content.result] : [];
    });
    assert.equal(actions.slice(0, -1).join(""), output);
    const observations = {
      passed: true,
      journalReopened: true,
      realHttpActivities: received.length,
      visibleOutputBytes: reconstructed.length,
      outputBlocks: blocks.length,
      failedOutputVisible: true,
      structuredResultsRetained: true,
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
