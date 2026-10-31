import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openExecutionJournal, type WorkCommand } from "../../src/runner-journal";

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
const requestId = "11111111-1111-4111-8111-111111111111";
const prefix = Buffer.from(
  JSON.stringify({
    type: "question",
    requestId,
    question: "Which API?",
    options: [{ label: "Existing API", value: "existing_api" }],
  }) + "\n",
);
type Observe = (name: string, passed: boolean, observed: unknown) => void;

export function probeRunnerJournal(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const child = Bun.spawnSync(
    [process.execPath, "--no-env-file", import.meta.path, "--write", root],
    {
      env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: root },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  assert.equal(child.signalCode, "SIGKILL", child.stderr.toString());
  const id = readFileSync(join(root, "execution"), "utf8");
  let journal = openExecutionJournal(root);
  try {
    assert.equal(journal.admit(command, 2000), null);
    assert.deepEqual(
      journal.executions(true).map((entry) => entry.id),
      [id],
    );
    assert.equal(journal.pending(id)[0]?.sequence, 1);
    assert.deepEqual(journal.pending(id)[0]?.event, {
      type: "question",
      text: "Which API?",
      options: [{ label: "Existing API", value: "existing_api" }],
    });
    assert.equal(journal.requestId(id, 1), requestId);
    assert.deepEqual(journal.transcriptCursor(id), {
      offset: prefix.length,
      consumed: prefix.length,
    });
    assert.throws(() => journal.transcriptUploaded(id, 0, prefix.length));
    assert.throws(() => journal.transcriptUploaded(id, prefix.length, prefix.length + 1));
    observe("SIGKILL recovery retains one execution and its typed question", true, {
      signal: child.signalCode,
      execution: id,
      pending: journal.pending(id),
    });
    const next = Buffer.from(
      JSON.stringify({
        type: "question",
        requestId: "22222222-2222-4222-8222-222222222222",
        question: "Next?",
        options: [],
      }) + '\n{"type":"question"}\n',
    );
    assert.throws(() => journal.ingest(id, Buffer.concat([prefix, next])));
    assert.equal(journal.pending(id).length, 1);
    assert.throws(() =>
      journal.ingest(id, Buffer.from(prefix.toString().replace("Which", "Other"))),
    );
    journal.ingest(id, prefix);
    assert.equal(journal.pending(id).length, 1);
    observe("Invalid suffixes roll back delivery and prefix cursors atomically", true, {
      pending: journal.pending(id).length,
    });
    assert.throws(() => journal.answered(id, 2), /delivered question/);
    journal.ingest(id, Buffer.concat([prefix, next.subarray(0, next.indexOf(10) + 1)]));
    assert.equal(journal.pending(id).length, 2);
    journal.sent(id, 1);
    journal.sent(id, 2);
    assert.throws(() => journal.answered(id, 2), /earlier question/);
    assert.equal(journal.answerCursor(id), 0);
    journal.answered(id, 1);
    journal.answered(id, 2);
    journal.answered(id, 1);
    const receiptRequest = "33333333-3333-4333-8333-333333333333";
    const receiptRecords = Buffer.from(
      [
        {
          type: "artifact",
          requestId: receiptRequest,
          artifact: {
            id: receiptRequest,
            path: "proof.txt",
            displayName: "proof.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            sha256: "a".repeat(64),
            attachToIssue: true,
          },
        },
        {
          type: "question",
          requestId: "44444444-4444-4444-8444-444444444444",
          question: "Receipt accepted?",
          options: [],
        },
      ]
        .map((record) => JSON.stringify(record) + "\n")
        .join(""),
    );
    const consumed = Buffer.concat([
      prefix,
      next.subarray(0, next.indexOf(10) + 1),
      receiptRecords,
    ]);
    journal.ingest(id, consumed);
    assert.equal(journal.requestId(id, 3), receiptRequest);
    assert.throws(() => journal.answered(id, 3), /delivered question/);
    journal.sent(id, 3);
    journal.sent(id, 4);
    assert.throws(() => journal.answered(id, 4), /earlier question or artifact/);
    assert.equal(journal.answerCursor(id), 2);
    journal.answered(id, 3);
    journal.answered(id, 4);
    journal.close();
    journal = openExecutionJournal(root);
    assert.deepEqual(journal.pending(id), []);
    assert.equal(journal.answerCursor(id), 4);
    assert.equal(journal.phase(id, "interrupted"), true);
    assert.equal(journal.phase(id, "running"), false);
    journal.ingest(id, Buffer.concat([consumed, Buffer.from('{"type":')]));
    assert.throws(() => journal.ingest(id, Buffer.concat([prefix, prefix])), /terminal/);
    assert.deepEqual(journal.pending(id), []);
    assert.equal(journal.admit(command, 3000), null);
    assert.deepEqual(journal.executions(true), []);
    observe("Restart retains receipts and terminal executions cannot relaunch", true, {
      answerCursor: journal.answerCursor(id),
      phase: journal.executions(false)[0]?.phase,
    });
  } finally {
    journal.close();
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--write") {
    const root = process.argv[3]!;
    const journal = openExecutionJournal(root);
    const execution = journal.admit(command, 1000)!;
    journal.ingest(execution.id, Buffer.concat([prefix, Buffer.from('{"type":')]));
    journal.transcriptUploaded(execution.id, 0, prefix.length);
    writeFileSync(join(root, "execution"), execution.id);
    process.kill(process.pid, "SIGKILL");
  } else {
    const root = mkdtempSync(join(tmpdir(), "paws-runner-journal-"));
    const observations: unknown[] = [];
    probeRunnerJournal(root, (name, passed, observed) => {
      observations.push({ name, passed, observed });
    });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(`VERIFIED execution journal crash recovery; evidence ${root}`);
  }
}
