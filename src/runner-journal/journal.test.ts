import { test, expect } from "bun:test";
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
test("durable execution admission preserves question values and rejects changed journal prefixes atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-journal-"));
  let journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const prefix = Buffer.from(
      `${JSON.stringify({ type: "question", requestId: "11111111-1111-4111-8111-111111111111", question: "Which API?", options: [{ label: "Existing API", value: "existing_api" }] })}\n`,
    );
    journal.ingest(execution.id, Buffer.concat([prefix, Buffer.from('{"type":')]));
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
    expect(() =>
      journal.ingest(execution.id, Buffer.from(prefix.toString().replace("Which", "Other"))),
    ).toThrow("rewritten");
    expect(journal.pending(execution.id)).toHaveLength(1);
    journal.ingest(execution.id, prefix);
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
  test(`terminal ${phase} execution refuses new records while queued deliveries can be acknowledged`, () => {
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
      journal.ingest(execution.id, prefix);
      journal.phase(execution.id, phase);
      journal.close();
      journal = openExecutionJournal(root);
      expect(() => journal.ingest(execution.id, Buffer.concat([prefix, prefix]))).toThrow(
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

test("answer receipts require delivered questions and preserve gaps over progress", () => {
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
    journal.ingest(
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

test("live deliveries include tool status and output while private thoughts stay local", () => {
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

test("permission decisions are delivered with their reason and secrets redacted", () => {
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
    journal.ingest(
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

test("pull request records carry the agent's title and description", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-pr-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const valid = `${JSON.stringify({ type: "pull_request", title: "Add rows", body: "Adds rows." })}\n`;
    journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      { sequence: 1, event: { type: "pull_request", title: "Add rows", body: "Adds rows." } },
    ]);
    expect(() =>
      journal.ingest(
        execution.id,
        Buffer.from(valid + `${JSON.stringify({ type: "pull_request", title: "", body: "x" })}\n`),
      ),
    ).toThrow("Invalid runner pull request");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Closeout records carry the agent's check attempt and output", () => {
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
    journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      { sequence: 1, event: { type: "closeout", progress } },
    ]);
    expect(() =>
      journal.ingest(
        execution.id,
        Buffer.from(
          valid +
            `${JSON.stringify({ type: "closeout", progress: { ...progress, type: "finished" } })}\n`,
        ),
      ),
    ).toThrow("Invalid runner Closeout progress");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress records carry the agent's update text", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-progress-"));
  const journal = openExecutionJournal(root);
  try {
    const execution = journal.admit(command, 1000)!;
    const valid = `${JSON.stringify({ type: "progress", text: "Found the cause." })}\n`;
    journal.ingest(execution.id, Buffer.from(valid));
    expect(journal.pending(execution.id)).toEqual([
      { sequence: 1, event: { type: "progress", text: "Found the cause." } },
    ]);
    expect(() =>
      journal.ingest(
        execution.id,
        Buffer.from(valid + `${JSON.stringify({ type: "progress", text: "x".repeat(501) })}\n`),
      ),
    ).toThrow("Invalid runner progress");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan records replace the checklist without waiting for an answer", () => {
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
    journal.ingest(execution.id, Buffer.from(valid));
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
    expect(() =>
      journal.ingest(
        execution.id,
        Buffer.from(valid + `${JSON.stringify({ type: "plan", steps: [] })}\n`),
      ),
    ).toThrow("Invalid runner plan");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
