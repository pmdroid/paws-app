import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExecutionJournal, type WorkCommand } from "./index";

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
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://github.com/owner/repo.git",
    baseSha: "a".repeat(40),
  },
  profile: { agent: "codex", model: null },
  prompt: "Implement delegated work",
};
test("policy chunk requests retain their offset and digest through the journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-policy-chunk-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const requestId = "11111111-1111-4111-8111-111111111111";
    const event = { type: "closeout_policy" as const, offset: 24000, hash: "a".repeat(64) };
    await journal.ingest(execution.id, Buffer.from(JSON.stringify({ ...event, requestId }) + "\n"));
    expect(journal.pending(execution.id)).toEqual([{ sequence: 1, event }]);
    expect(journal.requestId(execution.id, 1)).toBe(requestId);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("durable execution admission preserves question values and rejects changed journal prefixes atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-journal-"));
  let journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const prefix = Buffer.from(
      `${JSON.stringify({ type: "question", requestId: "11111111-1111-4111-8111-111111111111", question: "Which API?", options: [{ label: "Existing API", value: "existing_api" }] })}\n`,
    );
    await journal.ingest(execution.id, Buffer.concat([prefix, Buffer.from('{"type":')]));
    expect(journal.pending(execution.id)).toEqual([
      {
        sequence: 1,
        event: {
          type: "question",
          text: "Which API?",
          options: [{ label: "Existing API", value: "existing_api" }],
        },
      },
    ]);
    journal.close();
    journal = openExecutionJournal(root);
    expect(journal.admit(command, 2000)).toBeNull();
    expect(journal.executions(true).map((value) => value.id)).toEqual([execution.id]);
    expect(() => journal.admit({ ...command, prompt: "Changed" }, 2000)).toThrow(
      "Persisted command changed",
    );
    await expect(
      journal.ingest(execution.id, Buffer.from(prefix.toString().replace("Which", "Other"))),
    ).rejects.toThrow("rewritten");
    expect(journal.pending(execution.id)).toHaveLength(1);
    await journal.ingest(execution.id, prefix);
    journal.sent(execution.id, 1);
    expect(journal.pending(execution.id)).toEqual([]);
    expect(journal.requestId(execution.id, 1)).toBe("11111111-1111-4111-8111-111111111111");
    journal.phase(execution.id, "interrupted");
    expect(journal.executions(true)).toEqual([]);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const phase of ["complete", "interrupted"] as const) {
  test(`terminal ${phase} execution refuses new records while queued deliveries can be acknowledged`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-execution-terminal-"));
    let journal = openExecutionJournal(root);
    try {
      const execution = journal.admit(command, 1000)!;
      const prefix = Buffer.from(
        JSON.stringify({
          type: "question",
          requestId: "11111111-1111-4111-8111-111111111111",
          question: "Existing?",
          options: [],
        }) + "\n",
      );
      await journal.ingest(execution.id, prefix);
      journal.phase(execution.id, phase);
      journal.close();
      journal = openExecutionJournal(root);
      await expect(journal.ingest(execution.id, Buffer.concat([prefix, prefix]))).rejects.toThrow(
        "terminal",
      );
      expect(journal.pending(execution.id)).toHaveLength(1);
      journal.sent(execution.id, 1);
      journal.answered(execution.id, 1);
      expect(journal.pending(execution.id)).toEqual([]);
      expect(journal.answerCursor(execution.id)).toBe(1);
      expect(journal.admit(command, 2000)).toBeNull();
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("answer receipts require delivered questions and preserve gaps over progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-answers-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const question = {
      type: "question",
      requestId: "11111111-1111-4111-8111-111111111111",
      question: "Which API?",
      options: [],
    };
    await journal.ingest(
      execution.id,
      Buffer.from(
        [
          question,
          {
            type: "acp",
            event: {
              type: "session_update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Working" },
              },
            },
          },
          { ...question, requestId: "22222222-2222-4222-8222-222222222222" },
          {
            type: "artifact",
            requestId: "33333333-3333-4333-8333-333333333333",
            artifact: {
              id: "33333333-3333-4333-8333-333333333333",
              path: "proof.txt",
              displayName: "proof.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
              sha256: "a".repeat(64),
              attachToIssue: true,
            },
          },
          { ...question, requestId: "44444444-4444-4444-8444-444444444444" },
        ]
          .map((value) => JSON.stringify(value) + "\n")
          .join(""),
      ),
    );
    expect(() => journal.answered(execution.id, 1)).toThrow("delivered question");
    journal.sent(execution.id, 1);
    journal.sent(execution.id, 2);
    journal.sent(execution.id, 3);
    expect(() => journal.answered(execution.id, 2)).toThrow("delivered question");
    expect(() => journal.answered(execution.id, 99)).toThrow("delivered question");
    expect(journal.answerCursor(execution.id)).toBe(0);
    expect(() => journal.answered(execution.id, 3)).toThrow("earlier question");
    expect(journal.answerCursor(execution.id)).toBe(0);
    journal.answered(execution.id, 1);
    journal.answered(execution.id, 3);
    journal.answered(execution.id, 1);
    expect(journal.answerCursor(execution.id)).toBe(3);
    expect(() => journal.answered(execution.id, 4)).toThrow("delivered question");
    journal.sent(execution.id, 4);
    journal.sent(execution.id, 5);
    expect(() => journal.answered(execution.id, 5)).toThrow("earlier question or artifact");
    expect(journal.answerCursor(execution.id)).toBe(3);
    journal.answered(execution.id, 4);
    journal.answered(execution.id, 5);
    journal.answered(execution.id, 3);
    expect(journal.answerCursor(execution.id)).toBe(5);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live deliveries include tool status and output while private thoughts stay local", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-tool-progress-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const updates = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "private reasoning" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "browser",
        title: "Run browser",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "browser",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Screenshot saved" } }],
      },
    ];
    await journal.ingest(
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
    const events = journal.pending(execution.id).map((row) => row.event);
    expect(events).toEqual([
      {
        type: "activity",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "browser",
          title: "Run browser",
          status: "in_progress",
        },
      },
      {
        type: "activity",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "browser",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Screenshot saved" } }],
        },
      },
    ]);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission decisions are delivered with their reason and secrets redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-permission-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const decisions = [
      {
        type: "permission",
        toolCallId: "find",
        decision: "deny",
        reason: "path is outside the worktree",
        title: "find / -path '*react-router/package.json'",
        kind: "execute",
        name: "run_terminal_command",
      },
      {
        type: "permission",
        toolCallId: "read",
        decision: "allow",
        reason: "paths are inside the worktree",
        optionId: "allow",
        title: "Read .env with token=ghp_abcdefghijklmnopqrstuvwxyz",
        kind: "read",
      },
    ];
    await journal.ingest(
      execution.id,
      Buffer.from(decisions.map((event) => JSON.stringify({ type: "acp", event }) + "\n").join("")),
    );
    expect(journal.pending(execution.id).map((row) => row.event)).toEqual([
      {
        type: "permission",
        permission: {
          toolCallId: "find",
          decision: "deny",
          reason: "path is outside the worktree",
          title: "find / -path '*react-router/package.json'",
          kind: "execute",
          name: "run_terminal_command",
        },
      },
      {
        type: "permission",
        permission: {
          toolCallId: "read",
          decision: "allow",
          reason: "paths are inside the worktree",
          optionId: "allow",
          title: "Read .env with token=[redacted]",
          kind: "read",
        },
      },
    ]);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull request records carry the agent's title and description", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-pr-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const valid = `${JSON.stringify({ type: "pull_request", title: "Add rows", body: "Adds rows." })}\n`;
    await journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      { sequence: 1, event: { type: "pull_request", title: "Add rows", body: "Adds rows." } },
    ]);
    await expect(
      journal.ingest(
        execution.id,
        Buffer.from(valid + `${JSON.stringify({ type: "pull_request", title: "", body: "x" })}\n`),
      ),
    ).rejects.toThrow("Invalid runner pull request");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Closeout records carry the agent's check attempt and output", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-closeout-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const progress = {
      type: "started" as const,
      head: "a".repeat(40),
      id: "test",
      kind: "command",
      command: "bun test",
      attempt: 2,
      maxAttempts: 3,
    };
    const valid = `${JSON.stringify({ type: "closeout", progress })}\n`;
    await journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      { sequence: 1, event: { type: "closeout", progress } },
    ]);
    await expect(
      journal.ingest(
        execution.id,
        Buffer.from(
          valid +
            `${JSON.stringify({ type: "closeout", progress: { ...progress, type: "finished" } })}\n`,
        ),
      ),
    ).rejects.toThrow("Invalid runner Closeout progress");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress records carry the agent's update text", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-progress-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const valid = `${JSON.stringify({ type: "progress", text: "Found the cause." })}\n`;
    await journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      { sequence: 1, event: { type: "progress", text: "Found the cause." } },
    ]);
    await expect(
      journal.ingest(
        execution.id,
        Buffer.from(valid + `${JSON.stringify({ type: "progress", text: "x".repeat(501) })}\n`),
      ),
    ).rejects.toThrow("Invalid runner progress");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan records replace the checklist without waiting for an answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-plan-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const valid = `${JSON.stringify({
      type: "plan",
      steps: [
        { content: "Read the export", status: "completed" },
        { content: "Write the parser", status: "inProgress" },
      ],
    })}\n`;
    await journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      {
        sequence: 1,
        event: {
          type: "plan",
          steps: [
            { content: "Read the export", status: "completed" },
            { content: "Write the parser", status: "inProgress" },
          ],
        },
      },
    ]);
    expect(journal.requestId(execution.id, 1)).toBeNull();
    await expect(
      journal.ingest(
        execution.id,
        Buffer.from(valid + `${JSON.stringify({ type: "plan", steps: [] })}\n`),
      ),
    ).rejects.toThrow("Invalid runner plan");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session upload cursor survives a reopen and stops once the snapshot is settled", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-journal-"));
  let journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    expect(journal.sessionCursor(execution.id)).toEqual({ offset: 0, state: "" });
    journal.sessionUploaded(execution.id, 0, 524_288);
    expect(() => journal.sessionUploaded(execution.id, 0, 524_288)).toThrow("offset changed");
    journal.close();
    journal = openExecutionJournal(root);
    expect(journal.sessionCursor(execution.id)).toEqual({ offset: 524_288, state: "" });
    journal.sessionDone(execution.id, "sealed");
    journal.sessionDone(execution.id, "skipped");
    expect(journal.sessionCursor(execution.id)).toEqual({ offset: 524_288, state: "sealed" });
    expect(() => journal.sessionUploaded(execution.id, 524_288, 600_000)).toThrow("offset changed");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("a publication keeps its first outcome, published commit and refusal across reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-publication-journal-"));
  let journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const outcome = {
      executionId: execution.id,
      commandId: command.id,
      role: "implementer" as const,
      stopReason: "end_turn" as const,
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      candidateSha: "b".repeat(40),
      tokens: 7,
    };
    expect(await journal.beginPublication(execution.id, outcome, "c".repeat(40))).toEqual({
      result: outcome,
      lease: "c".repeat(40),
    });
    expect(journal.execution(execution.id)?.phase).toBe("publishing");
    await journal.beginPublication(execution.id, { ...outcome, stopReason: "error" });
    expect(journal.publication(execution.id)?.result.stopReason).toBe("end_turn");
    expect(() => journal.published(execution.id, "not a sha")).toThrow();
    journal.published(execution.id, "d".repeat(40));
    journal.close();
    journal = openExecutionJournal(root);
    expect(journal.executions(true).map((entry) => entry.phase)).toEqual(["publishing"]);
    journal.refusePublication(execution.id, "fenced by Paws");
    journal.refusePublication(execution.id, "cancelled by Paws");
    journal.published(execution.id, "e".repeat(40));
    expect(journal.publication(execution.id)).toEqual({
      result: outcome,
      lease: "c".repeat(40),
      publishedSha: "d".repeat(40),
      refused: "fenced by Paws",
    });
    expect(journal.hasResult(execution.id)).toBe(false);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("termination survives reopen and receipt replay cannot admit a canceled generation", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-termination-"));
  let journal = openExecutionJournal(root);
  const cancellation = { id: "cancel", runId: command.runId, generation: command.generation };
  try {
    journal.confirmTermination(cancellation);
    journal.close();
    journal = openExecutionJournal(root);
    const report = { runId: command.runId, generation: command.generation, commandId: "cancel" };
    expect(journal.pendingTerminations()).toEqual([report]);
    expect(journal.admit(command, 1000)).toBeNull();
    // A different generation has its own authority and termination obligation.
    expect(journal.admit({ ...command, id: "new-command", generation: 2 }, 1001)).not.toBeNull();
    journal.terminationReported({ ...report, generation: 2 });
    expect(journal.pendingTerminations()).toEqual([report]);
    journal.terminationReported(report);
    expect(journal.pendingTerminations()).toEqual([]);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade reconciles historical terminal executions through the broker contract", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-legacy-cleanup-"));
  let journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    journal.phase(execution.id, "interrupted");
    journal.close();
    journal = openExecutionJournal(root);
    expect(journal.executions(true)).toEqual([]);
    expect(journal.unconfirmedTerminations().map((entry) => entry.id)).toEqual([execution.id]);
    journal.confirmTermination(command);
    expect(journal.unconfirmedTerminations()).toEqual([]);
    expect(journal.pendingTerminations()).toEqual([
      { runId: command.runId, generation: 1, commandId: command.id },
    ]);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade reconciles a terminal execution an older release stored in a shape this release rejects", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-legacy-payload-"));
  let journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    journal.phase(execution.id, "complete");
    journal.close();
    const legacy = { ...command, commitPolicy: { projectLead: "lead", taskSteerer: "steerer" } };
    const db = new Database(join(root, "executions.db"));
    db.run("UPDATE execution SET payload=? WHERE id=?", [JSON.stringify(legacy), execution.id]);
    db.close();
    journal = openExecutionJournal(root);
    expect(journal.unconfirmedTerminations()).toEqual([
      {
        id: execution.id,
        command: { id: command.id, runId: command.runId, generation: 1, itemId: command.itemId },
      },
    ]);
    journal.confirmTermination(command);
    expect(journal.unconfirmedTerminations()).toEqual([]);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("journal lines with and without their write time deliver the same events", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-journal-time-"));
  const journal = openExecutionJournal(root);
  try {
    const lines = [
      { type: "progress", text: "Working." },
      {
        type: "acp",
        event: {
          type: "session_update",
          update: { sessionUpdate: "tool_call", toolCallId: "a", title: "Run", status: "pending" },
        },
      },
    ];
    const deliver = async (id: string, t?: string) => {
      const execution = journal.admit({ ...command, id, runId: id }, 1000)!;
      await journal.ingest(
        execution.id,
        Buffer.from(
          lines.map((line) => JSON.stringify({ ...line, ...(t ? { t } : {}) }) + "\n").join(""),
        ),
      );
      return journal.pending(execution.id);
    };
    const timed = await deliver("timed", "2026-11-03T18:09:14.123Z");
    expect(timed).toHaveLength(2);
    expect(timed).toEqual(await deliver("untimed"));
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
