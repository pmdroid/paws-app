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
