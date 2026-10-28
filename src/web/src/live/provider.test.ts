import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  appendCloseoutOutput,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  enqueueJob,
  enqueueOutbox,
  enterMergeQueue,
  finishCloseoutProgress,
  insertLinkAsk,
  insertQueuedItem,
  LINEAR_WEBHOOK_FIX,
  joinMergeQueue,
  keepTaskMergeSettings,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordCiRound,
  recordConfirmedRemoteMerge,
  saveCloseoutBypassChecks,
  saveCloseoutRecovery,
  saveEvidence,
  saveTaskMode,
  saveTaskBlocks,
  startCloseoutRound,
  upsertCloseoutStep,
  type CloseoutStepWrite,
  saveCandidateRisk,
  saveRiskFix,
} from "../../../db";
import { parseStatusItemDetail, parseStatusSnapshot, statusIntegrity } from "../contract";
import { handleStatusRequest, startStatusServer } from "../engine";
import { createLiveStatusProvider, STATUS_RECENT_LIMIT, STATUS_RECENT_MS } from "./provider";
import { waitReason } from "../client/format";
import { renderMergeQueue } from "../client/merge-queue";

const open: Database[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function seedQuestion(db: Database, itemId: string, sessionId: string): void {
  db.run(
    "INSERT INTO question (id, item_id, session_id, body, options, status, created_at) VALUES ('question', ?, ?, 'Which screenshot?', ?, 'open', 1)",
    [itemId, sessionId, JSON.stringify(["Existing", "Fresh"])],
  );
}

describe("live status provider", () => {
  test("HTTP status exposes migrated failures and budget questions without obsolete item states", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    migrate(db, { until: "147_job_item_version_and_question_reason" });
    insertQueuedItem(db, { id: "legacy-budget" });
    db.run("UPDATE work_item SET state='exhausted' WHERE id='legacy-budget'");
    migrate(db);
    insertQueuedItem(db, { id: "budget-question" });
    beginImplementRun(db, "budget-question", 1);
    applyWorkItemEvent(db, "budget-question", "blocking_question");
    seedQuestion(db, "budget-question", "session");
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    expect(response?.status).toBe(200);
    const body = parseStatusSnapshot(await response!.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.snapshot.items.find((item) => item.id === "legacy-budget")?.state).toBe(
      "needs_human",
    );
    expect(body.snapshot.items.find((item) => item.id === "budget-question")?.state).toBe(
      "awaiting_input",
    );
    expect(body.snapshot.questions).toHaveLength(1);
    expect(
      body.snapshot.items.every(
        (item) => !["exhausted", "awaiting_signoff", "signoff"].includes(item.state),
      ),
    ).toBe(true);
  });

  test("HTTP questions hand off to their own persisted Linear session", async () => {
    const db = database();
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "new-session" });
    seedQuestion(db, item.id, "question-session");
    const source = "https://linear.app/paws/issue/ENG-1/demo#agent-session-question";
    for (const [session, url] of [
      ["question-session", source],
      ["new-session", "https://linear.app/paws/issue/ENG-2/another"],
    ] as const) {
      db.run(
        "INSERT INTO inbox_event (dedupe_key, source, action, session_id, updated_at_ms, payload, received_at) VALUES (?, 'webhook', 'created', ?, 1, ?, 1)",
        [session, session, JSON.stringify({ agentSession: { url } })],
      );
    }
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const parsed = parseStatusSnapshot(await response!.json());
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.snapshot.questions.find((entry) => entry.id === "question")?.links).toEqual([
        { label: "Answer in Linear", href: source },
      ]);
  });

  test.each([
    "javascript:alert(1)",
    "https://linear.app.evil.example/question",
    "https://private:secret@linear.app/question",
    "https://uploads.linear.app/question?signature=secret",
    "https://linear.app:444/question",
  ])("question handoff falls back safely from an unsafe source %s", (url) => {
    const db = database();
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    seedQuestion(db, item.id, "session");
    db.run(
      "INSERT INTO inbox_event (dedupe_key, source, action, session_id, updated_at_ms, payload, received_at) VALUES ('event', 'webhook', 'created', 'session', 1, ?, 1)",
      [JSON.stringify({ agentSession: { url } })],
    );
    expect(createLiveStatusProvider(db).snapshot().questions[0]?.links).toEqual([
      { label: "Answer in Linear", href: "https://linear.app/issue/ENG-1" },
    ]);
  });

  test("a Linear question without session metadata uses its readable issue key", () => {
    const db = database();
    const item = insertQueuedItem(db, { id: "ENG-123", sessionKey: "session" });
    db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", [
      "9cfb482a-81e3-4154-b5b9-2c805e70a02d",
      item.id,
    ]);
    seedQuestion(db, item.id, "session");
    expect(createLiveStatusProvider(db).snapshot().questions[0]?.links).toEqual([
      { label: "Answer in Linear", href: "https://linear.app/issue/ENG-123" },
    ]);
  });

  test("visual review rounds carry the reviewer's name, feedback and the screenshots' commit", () => {
    const db = database();
    const item = insertQueuedItem(db, { id: "ENG-9", sessionKey: "session", now: 1_000 });
    const { run } = beginImplementRun(db, item.id, 1_000);
    putWorkspaceUser(db, {
      id: "user-ada",
      linearUserId: "lin-ada",
      name: "Ada Reviewer",
      email: "ada@example.invalid",
    });
    for (const [id, commit] of [
      ["shot-1", "a".repeat(40)],
      ["shot-2", "b".repeat(40)],
    ] as const)
      saveEvidence(db, {
        id,
        itemId: item.id,
        runId: run.id,
        checkId: "visual-proof",
        attempt: 1,
        mediaType: "image/png",
        sizeBytes: 4,
        sha256: "0".repeat(64),
        displayName: `${id}.png`,
        headCommit: commit,
        createdAt: 1_000,
      });
    db.run(
      `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, kind, outcome, answered_by, answered_at, feedback)
       VALUES ('q-1', ?, 'visual-proof', '["shot-1"]', 2000, 'review', 'changes_requested', 'lin-ada', 3000, 'Make the button blue.'),
              ('q-2', ?, 'visual-proof', '[]', 3000, 'continue', 'continued', 'lin-ada', 3500, NULL),
              ('q-3', ?, 'visual-proof', '["shot-2"]', 4000, 'review', NULL, NULL, NULL, NULL)`,
      [item.id, item.id, item.id],
    );
    const snapshot = createLiveStatusProvider(db).snapshot();
    expect(snapshot.items[0]?.visualReviews).toEqual([
      {
        questionId: "q-1",
        checkId: "visual-proof",
        round: 1,
        state: "changes_requested",
        evidenceIds: ["shot-1"],
        commit: "a".repeat(40),
        askedAt: new Date(2000).toISOString(),
        answeredBy: "Ada Reviewer",
        answeredAt: new Date(3000).toISOString(),
        feedback: "Make the button blue.",
      },
      {
        questionId: "q-3",
        checkId: "visual-proof",
        round: 2,
        state: "waiting",
        evidenceIds: ["shot-2"],
        commit: "b".repeat(40),
        askedAt: new Date(4000).toISOString(),
        answeredBy: null,
        answeredAt: null,
        feedback: null,
      },
    ]);
    expect(parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot))).ok).toBe(true);
  });

  test("a carried-over review names the approval and approver each screen came from", () => {
    const db = database();
    const item = insertQueuedItem(db, { id: "ENG-9", sessionKey: "session", now: 1_000 });
    const { run } = beginImplementRun(db, item.id, 1_000);
    putWorkspaceUser(db, {
      id: "user-ada",
      linearUserId: "lin-ada",
      name: "Ada Reviewer",
      email: "ada@example.invalid",
    });
    for (const id of ["shot-1", "shot-2"])
      saveEvidence(db, {
        id,
        itemId: item.id,
        runId: run.id,
        checkId: "visual-proof",
        attempt: 1,
        mediaType: "image/png",
        sizeBytes: 4,
        sha256: "0".repeat(64),
        displayName: "Settings.png",
        headCommit: "a".repeat(40),
        createdAt: 1_000,
      });
    const carried = [
      {
        evidenceId: "shot-2",
        fromEvidenceId: "shot-1",
        approvalId: "q-1",
        approvedBy: "lin-ada",
        approvedAt: 3000,
        match: "identical" as const,
      },
    ];
    db.run(
      `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, outcome, answered_by, answered_at, carried)
       VALUES ('q-1', ?, 'visual-proof', '["shot-1"]', 2000, 'stale', 'lin-ada', 3000, NULL),
              ('carry_1', ?, 'visual-proof', '["shot-2"]', 5000, 'accepted', 'lin-ada', 5000, ?)`,
      [item.id, item.id, JSON.stringify(carried)],
    );
    const snapshot = createLiveStatusProvider(db).snapshot();
    const reviews = snapshot.items[0]?.visualReviews;
    expect(reviews?.map((review) => [review.questionId, review.round, review.state])).toEqual([
      ["q-1", 1, "stale"],
      ["carry_1", 1, "accepted"],
    ]);
    expect(reviews?.[1]?.carried).toEqual([
      { ...carried[0]!, approvedBy: "Ada Reviewer", approvedAt: new Date(3000).toISOString() },
    ]);
    expect(parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot))).ok).toBe(true);
  });

  test("HTTP status reads each run's pinned reviewer independently of current settings", async () => {
    const db = database();
    const home = mkdtempSync(join(tmpdir(), "paws-status-reviewer-"));
    homes.push(home);
    const profiles = ["grok", "claude", "codex"] as const;
    const ids = profiles.map((reviewer, index) => {
      const item = insertQueuedItem(db, { id: `ENG-${index + 1}`, title: "Review", now: 1 });
      const { run } = beginImplementRun(db, item.id, 2);
      db.run("UPDATE run SET agent = ? WHERE id = ?", ["codex", run.id]);
      const dir = join(home, "runs", run.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "agent-profile.json"),
        JSON.stringify({
          profiles: {
            implementer: { agent: "codex", model: "model-a" },
            reviewer: { agent: reviewer, model: "model-b" },
          },
        }),
      );
      return run.id;
    });
    writeFileSync(join(home, "config.toml"), '[agents.defaults.reviewer]\nagent = "codex"\n');
    const server = startStatusServer({
      port: 0,
      db,
      closeoutHome: home,
      env: { PAWS_HOME: join(home, "wrong") },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/status`);
      expect(response.status).toBe(200);
      const parsed = parseStatusSnapshot(await response.json());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(ids.map((id) => parsed.snapshot.runs.find((run) => run.id === id)?.reviewer)).toEqual([
        "Grok",
        "Claude",
        "Codex",
      ]);
      expect(parsed.snapshot.runs.every((run) => run.agent === "Codex")).toBe(true);
      const responseFromEnv = await handleStatusRequest(
        new Request("http://127.0.0.1/api/status"),
        { db, env: { PAWS_HOME: home } },
      );
      const fromEnv = parseStatusSnapshot(await responseFromEnv!.json());
      expect(fromEnv.ok).toBe(true);
      if (fromEnv.ok)
        expect(fromEnv.snapshot.runs.find((run) => run.id === ids[0])?.reviewer).toBe("Grok");
    } finally {
      server.stop(true);
    }
  });

  test("missing or invalid saved reviewers do not invent a Codex reviewer or break status", async () => {
    const db = database();
    const home = mkdtempSync(join(tmpdir(), "paws-status-reviewer-"));
    homes.push(home);
    const item = insertQueuedItem(db, { id: "ENG-1", title: "Review", now: 1 });
    const { run } = beginImplementRun(db, item.id, 2);
    const dir = join(home, "runs", run.id);
    mkdirSync(dir, { recursive: true });
    for (const snapshot of [
      undefined,
      "{",
      "null",
      "{}",
      JSON.stringify({ profiles: { reviewer: { agent: "unexpected-secret" } } }),
    ]) {
      if (snapshot !== undefined) writeFileSync(join(dir, "agent-profile.json"), snapshot);
      const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
        db,
        closeoutHome: home,
        env: {},
      });
      expect(response?.status).toBe(200);
      const body = parseStatusSnapshot(await response!.json());
      expect(body.ok).toBe(true);
      if (body.ok) expect(body.snapshot.runs[0]?.reviewer).toBe("Unknown");
      expect(JSON.stringify(body)).not.toContain("unexpected-secret");
    }
  });

  test("an empty database is a live snapshot with no items", async () => {
    const db = database();
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    expect(response?.status).toBe(200);
    const body: unknown = await response?.json();
    const parsed = parseStatusSnapshot(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.source).toBe("live");
    expect(parsed.snapshot.items).toEqual([]);
    expect(parsed.snapshot.runs).toEqual([]);
    expect(parsed.snapshot.questions).toEqual([]);
    expect(parsed.snapshot.verdicts).toEqual([]);
    expect(parsed.snapshot.mergeQueue).toEqual([]);
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Audit log export");
    expect(JSON.stringify(body)).not.toContain("acme");
  });

  test("reads items, runs, an open question, Closeout, and the merge queue", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const waiting = insertQueuedItem(db, {
      id: "ENG-2",
      title: "Export rows",
      sessionKey: "ses_1",
      branchName: "paws/ENG-2",
      now,
    });
    const merging = insertQueuedItem(db, {
      id: "ENG-3",
      title: "Export the header",
      sessionKey: "ses_1",
      branchName: "paws/ENG-3",
      now,
    });
    const waitingRun = beginImplementRun(db, waiting.id, now);
    applyWorkItemEvent(db, waiting.id, "blocking_question");
    beginImplementRun(db, merging.id, now);
    enterMergeQueue(db, merging.id, { phase: "merge_queue", baseSha: base, wipCommit: head });
    const summary = [
      "Closeout: accepted",
      "Task: ENG-3",
      `Base: ${base}`,
      `Head: ${head}`,
      "Fix attempts: 1",
      "Evaluations: 2",
      "Exit: 0",
      "Items:",
      "- typecheck (command): passed — exited 0",
      "- adversarial-review (review): passed — no failing findings",
      "- docs-lint (command): skipped — no changed path matches",
    ].join("\n");
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${waitingRun.run.id}:first`,
      payload: { sessionId: "ses_1", kind: "thought", body: "Need a product decision." },
      now,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses_1",
      idempotencyKey: "ask:q-archived",
      payload: {
        sessionId: "ses_1",
        body: "Include archived rows?\n\nReply with one of the options, or answer in your own words.",
        options: ["yes", "no"],
      },
      now,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${merging.id}:verdict:${head}:accepted`,
      payload: { sessionId: "ses_1", kind: "response", body: summary },
      now,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${merging.id}:pr:7`,
      payload: {
        sessionId: "ses_1",
        kind: "response",
        body: "Opened https://github.com/pmdroid/paws-demo/pull/7.",
      },
      now,
    });
    enqueueJob(db, {
      queue: "github.merge",
      jobKey: `merge:${merging.id}:${head}`,
      payload: { itemId: merging.id, summary: `${summary}\nCaller attempt: 2`, head },
      now,
    });

    const provider = createLiveStatusProvider(db, { now: () => new Date(now) });
    const snapshot = provider.snapshot();
    const parsed = parseStatusSnapshot(snapshot);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(parsed.snapshot.source).toBe("live");
    expect(parsed.snapshot.project.team).toBe("ENG");
    expect(parsed.snapshot.items.map((item) => [item.id, item.state])).toEqual([
      ["ENG-3", "merge_queue"],
      ["ENG-2", "awaiting_input"],
    ]);
    expect(parsed.snapshot.items.every((item) => item.blockers.length === 0)).toBe(true);
    expect(
      parsed.snapshot.items.every((item) => item.owner === null && item.project === null),
    ).toBe(true);
    expect(parsed.snapshot.runs.map((run) => run.itemId).sort()).toEqual(["ENG-2", "ENG-3"]);
    const parked = parsed.snapshot.runs.find((run) => run.itemId === "ENG-2");
    expect(parked?.state).toBe("awaiting_input");
    expect(parked?.agent).toBe("Cursor");
    expect(parked?.activity.some((line) => line.text === "Need a product decision.")).toBe(true);
    expect(parsed.snapshot.questions).toEqual([
      expect.objectContaining({
        id: "q-archived",
        itemId: "ENG-2",
        title: "Include archived rows?",
        options: ["yes", "no"],
        kind: "decision",
        urgency: "blocking",
        links: [
          {
            label: "Answer in Linear",
            href: `https://linear.app/issue/${waiting.linearIdentifier}`,
          },
        ],
      }),
    ]);
    const verdict = parsed.snapshot.verdicts.find((entry) => entry.itemId === "ENG-3");
    expect(verdict?.decision).toBe("accepted");
    expect(verdict?.headSha).toBe(head);
    expect(provider.item("ENG-3")?.verdicts[0]?.baseSha).toBe(base);
    expect(verdict?.checks.map((check) => [check.id, check.kind, check.state])).toEqual([
      ["typecheck", "command", "passed"],
      ["adversarial-review", "review", "passed"],
    ]);
    // The merge job has not run yet, so the task holds no place in its repository's queue.
    expect(parsed.snapshot.mergeQueue).toEqual([
      expect.objectContaining({
        position: null,
        itemId: "ENG-3",
        repository: "pmdroid/paws-demo",
        waitingFor: "ci",
        acceptedAt: new Date(now).toISOString(),
        settings: { order: "queue", mainMoved: "ci", rule: null },
      }),
    ]);
    expect(parsed.snapshot.items.find((item) => item.id === "ENG-3")?.pr).toEqual({
      number: 7,
      url: "https://github.com/pmdroid/paws-demo/pull/7",
    });
    expect(JSON.stringify(snapshot)).not.toContain("Audit log export");
  });

  test("a waiting task without a question row shows its question:<id> elicitation", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const item = insertQueuedItem(db, { id: "ENG-2", sessionKey: "ses_1", now });
    beginImplementRun(db, item.id, now);
    applyWorkItemEvent(db, item.id, "blocking_question");
    enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses_1",
      idempotencyKey: "question:q-help",
      payload: { sessionId: "ses_1", body: "Closeout needs your help." },
      now,
    });
    expect(createLiveStatusProvider(db).snapshot().questions).toEqual([
      expect.objectContaining({
        id: "q-help",
        itemId: "ENG-2",
        title: "Closeout needs your help.",
      }),
    ]);
  });

  test("a bypass link ask carries its failed checks and the policy it binds to", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const head = "7f65200aa1b2c3d4";
    const item = insertQueuedItem(db, { id: "ENG-3", sessionKey: "ses_1", now });
    beginImplementRun(db, item.id, now);
    applyWorkItemEvent(db, item.id, "blocking_question");
    db.run(
      "INSERT INTO question (id, item_id, session_id, kind, body, status, created_at) VALUES ('q-bypass', ?, 'ses_1', 'link', 'Closeout needs your decision', 'open', ?)",
      [item.id, now],
    );
    insertLinkAsk(db, {
      questionId: "q-bypass",
      itemId: item.id,
      kind: "bypass",
      headCommit: head,
      link: "https://paws.example/status/issues/ENG-3#closeout",
      title: "Closeout needs your decision on 7f65200.",
      detail: "Closeout stopped on 7f65200: 1 check failed (test).",
      answerers: ["delegator"],
      createdAt: now,
    });
    saveCloseoutRecovery(db, {
      questionId: "q-bypass",
      taskId: "ENG-3",
      itemId: item.id,
      base: "base",
      head,
      policyDigest: "sha256:0eadf4c",
      failedChecks: ["test"],
      retryBaseline: [],
      summary: "Closeout: exhausted",
    });
    saveCloseoutBypassChecks(db, "q-bypass", [
      { id: "test", kind: "command", state: "exhausted", attempt: 3, message: "exited 1" },
    ]);
    expect(createLiveStatusProvider(db).snapshot().questions[0]?.linkAsk?.bypass).toEqual({
      policyDigest: "sha256:0eadf4c",
      passed: [],
      checks: [
        { id: "test", kind: "command", state: "exhausted", attempt: 3, finding: "exited 1" },
      ],
    });
  });

  test("a risk link ask carries the head's high-risk paths for the Risk card", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const head = "7f65200aa1b2c3d4";
    const item = insertQueuedItem(db, { id: "ENG-6", sessionKey: "ses_1", now });
    beginImplementRun(db, item.id, now);
    applyWorkItemEvent(db, item.id, "blocking_question");
    db.run(
      "INSERT INTO question (id, item_id, session_id, kind, body, status, created_at) VALUES ('q-risk', ?, 'ses_1', 'link', 'High-risk changes', 'open', ?)",
      [item.id, now],
    );
    insertLinkAsk(db, {
      questionId: "q-risk",
      itemId: item.id,
      kind: "risk",
      headCommit: head,
      link: "https://paws.example/status/issues/ENG-6#risk",
      title: "High-risk changes in 7f65200 need your approval.",
      detail: "High-risk paths changed: `src/auth/session.ts`.",
      answerers: ["delegator"],
      createdAt: now,
    });
    saveCandidateRisk(db, {
      itemId: item.id,
      head,
      base: "base",
      tier: "high",
      paths: ["src/auth/session.ts"],
      classifiedAt: now,
    });
    const snapshot = createLiveStatusProvider(db).snapshot();
    expect(snapshot.questions[0]?.linkAsk?.risk).toEqual({
      paths: ["src/auth/session.ts"],
      summary: "",
      findings: [],
    });
    // The snapshot still passes the contract the client reads.
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.ok && parsed.snapshot.questions[0]?.linkAsk?.risk).toEqual({
      paths: ["src/auth/session.ts"],
      summary: "",
      findings: [],
    });
  });

  test("a risk ask after an approval lists only the fix's high-risk paths", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const head = "9c1d2e3ff0a1b2c3";
    const item = insertQueuedItem(db, { id: "ENG-6", sessionKey: "ses_1", now });
    beginImplementRun(db, item.id, now);
    applyWorkItemEvent(db, item.id, "blocking_question");
    db.run(
      "INSERT INTO question (id, item_id, session_id, kind, body, status, created_at) VALUES ('q-risk', ?, 'ses_1', 'link', 'High-risk changes', 'open', ?)",
      [item.id, now],
    );
    insertLinkAsk(db, {
      questionId: "q-risk",
      itemId: item.id,
      kind: "risk",
      headCommit: head,
      link: "https://paws.example/status/issues/ENG-6#risk",
      title: "High-risk changes in 9c1d2e3 need your approval.",
      detail: "High-risk paths the fix changed since the approved 4b317d5: `src/auth/session.ts`.",
      answerers: ["delegator"],
      createdAt: now,
    });
    saveCandidateRisk(db, {
      itemId: item.id,
      head,
      base: "base",
      tier: "high",
      paths: ["src/auth/session.ts", "src/auth/token.ts"],
      classifiedAt: now,
    });
    saveRiskFix(db, {
      itemId: item.id,
      head,
      approvedHead: "4b317d5cc2",
      approvedQuestionId: "q-approved",
      changed: ["src/auth/session.ts", "test/x.test.ts"],
      paths: ["src/auth/session.ts"],
      recordedAt: now,
    });
    const snapshot = createLiveStatusProvider(db).snapshot();
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.ok && parsed.snapshot.questions[0]?.linkAsk?.risk).toEqual({
      paths: ["src/auth/session.ts"],
      since: "4b317d5cc2",
      summary: "",
      findings: [],
    });
    expect(snapshot.items[0]?.riskCarryOver).toBeUndefined();
  });

  test("an item whose latest head kept the approval carries it, with the approved head", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const item = insertQueuedItem(db, { id: "ENG-7", sessionKey: "ses_1", now });
    const risk = (head: string, at: number) =>
      saveCandidateRisk(db, {
        itemId: item.id,
        head,
        base: "base",
        tier: "high",
        paths: ["src/auth/session.ts"],
        classifiedAt: at,
      });
    risk("9c1d2e3ff0", now);
    saveRiskFix(db, {
      itemId: item.id,
      head: "9c1d2e3ff0",
      approvedHead: "4b317d5cc2",
      approvedQuestionId: "q-approved",
      changed: ["test/x.test.ts"],
      paths: [],
      recordedAt: now,
    });
    const carried = {
      head: "9c1d2e3ff0",
      approvedHead: "4b317d5cc2",
      changed: ["test/x.test.ts"],
      reason:
        "The approval of 4b317d5 carried over: none of the files the fix changed since then is a high-risk path (`test/x.test.ts`).",
    };
    const parsed = parseStatusSnapshot(
      JSON.parse(JSON.stringify(createLiveStatusProvider(db).snapshot())),
    );
    expect(parsed.ok && parsed.snapshot.items[0]?.riskCarryOver).toEqual(carried);
    // A newer head has not been compared yet, so the old carry-over no longer shows.
    risk("aaaa111122", now + 1);
    expect(createLiveStatusProvider(db).snapshot().items[0]?.riskCarryOver).toBeUndefined();
  });

  test("the merge queue lists each repository's tasks in order, with what each waits for", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const head = "c".repeat(40);
    const merging = (id: string, repository: string, ready: number | null, at: number) => {
      const item = insertQueuedItem(db, { id, title: id, sessionKey: "ses_q", now: at });
      beginImplementRun(db, item.id, at);
      enterMergeQueue(db, item.id, { phase: "merge_queue", baseSha: head, wipCommit: head });
      enqueueJob(db, {
        queue: "github.merge",
        jobKey: `merge:${item.id}`,
        payload: { itemId: item.id, head },
        now: at,
      });
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "ses_q",
        idempotencyKey: `${item.id}:pr:${at}`,
        payload: {
          sessionId: "ses_q",
          kind: "response",
          body: `Opened https://github.com/${repository}/pull/${at}.`,
        },
        now: at,
      });
      if (ready !== null) joinMergeQueue(db, { itemId: item.id, repository, now: ready });
      return item;
    };
    const first = merging("ENG-11", "acme/platform", 10, 1);
    merging("ENG-12", "acme/platform", 20, 2);
    const review = merging("ENG-13", "acme/web", null, 3);
    db.run("UPDATE job SET payload=? WHERE json_extract(payload,'$.itemId')=?", [
      JSON.stringify({
        itemId: review.id,
        head,
        mergeWait: { reason: "review", message: "Waiting for an approving review.", at: 4 },
      }),
      review.id,
    ]);
    keepTaskMergeSettings(
      db,
      review.id,
      {
        order: "ci-green",
        mainMoved: "closeout",
        resolved: { sources: { order: "rule", mainMoved: "rule" }, rule: { label: "Bug" } },
      },
      4,
    );
    const merged = merging("ENG-14", "acme/platform", null, 5);
    applyWorkItemEvent(db, merged.id, "merge_accepted");
    recordConfirmedRemoteMerge(db, {
      itemId: merged.id,
      repositoryOwner: "acme",
      repositoryName: "platform",
      pullNumber: 5,
      pullUrl: null,
      mergeSha: null,
      confirmedAt: now - 60_000,
    });
    const back = merging("ENG-15", "acme/platform", null, 6);
    applyWorkItemEvent(db, back.id, "ejected");
    enqueueJob(db, {
      queue: "run.resume",
      jobKey: `ci-failed:${back.id}:0`,
      payload: { itemId: back.id, reason: "ci-failed" },
      now: now - 120_000,
    });

    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now) }).snapshot();
    const parsed = parseStatusSnapshot(snapshot);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(
      parsed.snapshot.mergeQueue.map((entry) => [
        entry.repository,
        entry.position,
        entry.itemId,
        entry.waitingFor,
        entry.detail,
      ]),
    ).toEqual([
      ["acme/platform", 1, "ENG-11", "ci", null],
      ["acme/platform", 2, "ENG-12", "ahead", "Starts when #1 merges"],
      ["acme/web", null, "ENG-13", "review", "Waiting for an approving review."],
    ]);
    expect(parsed.snapshot.mergeQueue[2]?.settings).toEqual({
      order: "ci-green",
      mainMoved: "closeout",
      rule: "Bug",
    });
    expect(first.id).toBe("ENG-11");
    expect(
      parsed.snapshot.mergeHistory?.map((entry) => [entry.itemId, entry.outcome, entry.reason]),
    ).toEqual([
      ["ENG-14", "merged", null],
      ["ENG-15", "back_with_agent", "ci_failed"],
    ]);
  });

  test("a re-checking task keeps its place in the merge queue, and the ready one behind it moves", () => {
    const db = database();
    const head = "c".repeat(40);
    for (const [index, id] of ["ENG-21", "ENG-22", "ENG-23"].entries()) {
      const item = insertQueuedItem(db, { id, title: id, sessionKey: "ses_r", now: index + 1 });
      beginImplementRun(db, item.id, index + 1);
      enterMergeQueue(db, item.id, { phase: "merge_queue", baseSha: head, wipCommit: head });
      joinMergeQueue(db, { itemId: item.id, repository: "acme/platform", now: 10 * (index + 1) });
    }
    applyWorkItemEvent(db, "ENG-21", "reverify_requested");

    const parsed = parseStatusSnapshot(createLiveStatusProvider(db).snapshot());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(
      parsed.snapshot.mergeQueue.map((entry) => [
        entry.position,
        entry.itemId,
        entry.waitingFor,
        entry.detail,
      ]),
    ).toEqual([
      [1, "ENG-21", "closeout", "Re-checking, keeps its place."],
      [2, "ENG-22", "ci", null],
      [3, "ENG-23", "ahead", "Starts when ENG-22 merges"],
    ]);
    const items = new Map(parsed.snapshot.items.map((item) => [item.id, item.mergeQueue]));
    expect(items.get("ENG-21")).toMatchObject({ position: 1, ahead: null, rechecking: true });
    expect(items.get("ENG-22")).toMatchObject({ position: 2, ahead: null });
    expect(items.get("ENG-23")).toMatchObject({ position: 3, ahead: "ENG-22" });
  });

  test("the merge queue names each task's bound repository without a configured repo", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const head = "c".repeat(40);
    const bound = (id: string, at: number) => {
      const item = insertQueuedItem(db, { id, title: id, sessionKey: "ses_b", now: at });
      bindWorkItemRepository(db, item.id, {
        owner: "pmdroid",
        repo: "paws-app",
        remoteUrl: "https://github.com/pmdroid/paws-app.git",
      });
      beginImplementRun(db, item.id, at);
      enterMergeQueue(db, item.id, { phase: "merge_queue", baseSha: head, wipCommit: head });
      return item;
    };
    bound("ENG-21", 1);
    const back = bound("ENG-22", 2);
    applyWorkItemEvent(db, back.id, "ejected");
    enqueueJob(db, {
      queue: "run.resume",
      jobKey: `ci-failed:${back.id}:0`,
      payload: { itemId: back.id, reason: "ci-failed" },
      now: now - 120_000,
    });

    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now) }).snapshot();
    const parsed = parseStatusSnapshot(snapshot);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.mergeQueue.map((entry) => [entry.itemId, entry.repository])).toEqual([
      ["ENG-21", "pmdroid/paws-app"],
    ]);
    expect(
      parsed.snapshot.mergeHistory?.map((entry) => [entry.itemId, entry.repository, entry.outcome]),
    ).toEqual([["ENG-22", "pmdroid/paws-app", "back_with_agent"]]);
    const html = renderMergeQueue(parsed.snapshot);
    expect(html.match(/<h2 [^>]*>[^<]*<\/h2>/g)).toEqual([
      `<h2 id="merge-repo-pmdroid-paws-app">pmdroid/paws-app</h2>`,
    ]);
    expect(html).not.toContain("unknown");
    expect(html).not.toContain("Repository not known");
  });

  test("Closeout checks leave out policy items that did not apply to the change", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const head = "c".repeat(40);
    const item = insertQueuedItem(db, {
      id: "ENG-5",
      title: "Docs only",
      sessionKey: "ses_5",
      now,
    });
    beginImplementRun(db, item.id, now);
    enterMergeQueue(db, item.id, {
      phase: "merge_queue",
      baseSha: "d".repeat(40),
      wipCommit: head,
    });
    const identity = {
      taskId: item.id,
      base: "d".repeat(40),
      head,
      policyDigest: "sha256:policy",
      policyPath: ".agents/closeout.yaml",
    };
    const step = (id: string, state: CloseoutStepWrite["state"], ordinal: number) => ({
      id,
      kind: "command" as const,
      state,
      command: id,
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: now,
      finishedAt: now,
      exitCode: state === "passed" ? 0 : null,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: null,
      findings: null,
      ordinal,
    });
    upsertCloseoutStep(db, item.id, identity, step("test", "passed", 0), now);
    upsertCloseoutStep(db, item.id, identity, step("typecheck", "skipped", 1), now);
    finishCloseoutProgress(db, item.id, identity, "accepted", now);
    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now) }).snapshot();
    expect(snapshot.verdicts[0]?.checks.map((check) => [check.id, check.state])).toEqual([
      ["test", "passed"],
    ]);
  });

  test("the list carries open items and finished items of the last 24 hours, at most 50", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const finish = (id: string, at: number) => {
      insertQueuedItem(db, { id, title: id, now: at - 1_000 });
      applyWorkItemEvent(db, id, "cancel", { now: at });
    };
    // Open for a week: open items stay whatever their age.
    insertQueuedItem(db, { id: "ENG-OPEN", title: "Open", now: now - 7 * STATUS_RECENT_MS });
    finish("ENG-OLD", now - STATUS_RECENT_MS - 60_000);
    finish("ENG-RECENT", now - 60_000);
    const provider = createLiveStatusProvider(db, { now: () => new Date(now) });
    const ids = provider.snapshot().items.map((item) => item.id);
    expect(ids).toContain("ENG-OPEN");
    expect(ids).toContain("ENG-RECENT");
    expect(ids).not.toContain("ENG-OLD");
    // An item that left the list still has its own page.
    expect(provider.item("ENG-OLD")?.items.map((item) => [item.id, item.state])).toEqual([
      ["ENG-OLD", "stopped"],
    ]);

    for (let index = 0; index < STATUS_RECENT_LIMIT + 5; index += 1)
      finish(`ENG-${100 + index}`, now - 120_000 - index * 1_000);
    const capped = provider.snapshot().items;
    const finished = capped.filter((item) => item.state !== "queued").map((item) => item.id);
    expect(finished).toHaveLength(STATUS_RECENT_LIMIT);
    // The most recently finished stay; the oldest of the window fall off.
    expect(finished).toContain("ENG-RECENT");
    expect(finished).toContain("ENG-100");
    expect(finished).not.toContain(`ENG-${100 + STATUS_RECENT_LIMIT + 4}`);
    expect(capped.map((item) => item.id)).toContain("ENG-OPEN");
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(provider.snapshot())));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
  });

  test("the item detail reads each review round's findings from the stored review evidence", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "d".repeat(40);
    const pawsHome = mkdtempSync(join(tmpdir(), "paws-reviews-"));
    homes.push(pawsHome);
    const item = insertQueuedItem(db, {
      id: "ENG-11",
      title: "Reviews",
      sessionKey: "ses_11",
      now,
    });
    beginImplementRun(db, item.id, now);
    enterMergeQueue(db, item.id, {
      phase: "merge_queue",
      baseSha: base,
      wipCommit: "c".repeat(40),
    });
    const rounds = [
      {
        head: "a".repeat(40),
        findings: [
          {
            severity: "P1",
            location: "src/auth.ts:10",
            explanation: "token leaks",
            evidence: "e1",
          },
          { severity: "P2", location: "src/old.ts:4", explanation: "<b>stale</b>", evidence: "e2" },
        ],
        preExisting: [],
      },
      {
        head: "c".repeat(40),
        findings: [
          {
            severity: "P1",
            location: "src/auth.ts:12",
            explanation: "token leaks",
            evidence: "e3",
          },
          { severity: "P2", location: "src/legacy.ts:3", explanation: "old code", evidence: "e4" },
        ],
        preExisting: [1],
      },
    ];
    for (const [index, round] of rounds.entries()) {
      const at = now + index * 1000;
      const evidencePath = `evidence/policy/${round.head}/independent-review/${index + 1}.json`;
      const file = join(pawsHome, "closeout", "evidence", item.id, evidencePath);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          specVersion: "0.1",
          recordType: "review",
          task: item.id,
          itemId: "independent-review",
          base,
          head: round.head,
          policyDigest: "sha256:policy",
          attempt: index + 1,
          findings: round.findings,
          artifacts: [],
        }),
      );
      const identity = { taskId: item.id, base, head: round.head, policyDigest: "sha256:policy" };
      upsertCloseoutStep(
        db,
        item.id,
        { ...identity, policyPath: null },
        {
          id: "independent-review",
          kind: "review",
          state: "failed",
          command: "",
          detail: "finding at P1 meets failOn P1",
          attempt: index + 1,
          timeoutSeconds: null,
          startedAt: at,
          finishedAt: at,
          exitCode: null,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath,
          findings: null,
          ordinal: -1,
          failOn: "P1",
          preExisting: round.preExisting,
        },
        at,
      );
      finishCloseoutProgress(db, item.id, { ...identity, policyPath: null }, "rejected", at);
    }
    const provider = createLiveStatusProvider(db, { now: () => new Date(now + 5000), pawsHome });
    // Findings are only in the item detail, never in the list.
    expect(JSON.stringify(provider.snapshot())).not.toContain("token leaks");
    const [review] = provider.item("ENG-11")!.verdicts[0]!.reviews!;
    expect(review!.id).toBe("independent-review");
    const mark = (finding: {
      location: string;
      preExisting: boolean;
      blocking: boolean;
      since: string | null;
    }) => [finding.location, finding.preExisting, finding.blocking, finding.since];
    expect(review!.rounds[0]!.findings.map(mark)).toEqual([
      ["src/auth.ts:10", false, true, null],
      ["src/old.ts:4", false, false, null],
    ]);
    const latest = review!.rounds[1]!;
    expect(latest.failOn).toBe("P1");
    expect(latest.findings.map(mark)).toEqual([
      ["src/auth.ts:12", false, true, "open"],
      ["src/legacy.ts:3", true, false, "new"],
    ]);
    expect(latest.fixed.map((finding) => finding.explanation)).toEqual(["<b>stale</b>"]);
  });

  test("the item detail carries one issue's Closeout attempts without check logs", async () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "d".repeat(40);
    const item = insertQueuedItem(db, { id: "ENG-8", title: "Detail", sessionKey: "ses_8", now });
    const blocked = insertQueuedItem(db, { id: "ENG-9", sessionKey: "ses_8", now: now + 1 });
    insertQueuedItem(db, { id: "ENG-10", sessionKey: "ses_other", now });
    saveTaskBlocks(
      db,
      [blocked.linearIssueId],
      [{ blockerLinearIssueId: item.linearIssueId, blockedLinearIssueId: blocked.linearIssueId }],
    );
    beginImplementRun(db, item.id, now);
    enterMergeQueue(db, item.id, {
      phase: "merge_queue",
      baseSha: base,
      wipCommit: "c".repeat(40),
    });
    for (const [index, head] of ["a".repeat(40), "c".repeat(40)].entries()) {
      const at = now + index * 1000;
      const identity = {
        taskId: item.id,
        base,
        head,
        policyDigest: "sha256:policy",
        policyPath: null,
      };
      upsertCloseoutStep(
        db,
        item.id,
        identity,
        {
          id: "test",
          kind: "command",
          state: index === 0 ? "failed" : "passed",
          command: "bun test",
          detail: null,
          attempt: index + 1,
          timeoutSeconds: null,
          startedAt: at,
          finishedAt: at,
          exitCode: index === 0 ? 1 : 0,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath: null,
          findings: index === 0 ? "test failed" : null,
          ordinal: 0,
        },
        at,
      );
      appendCloseoutOutput(db, item.id, identity, "test", "stderr", "secret log", false, at);
      finishCloseoutProgress(db, item.id, identity, index === 0 ? "rejected" : "accepted", at);
    }
    const provider = createLiveStatusProvider(db, {
      now: () => new Date(now + 5000),
      sessionIds: ["ses_8"],
    });
    // The list carries one summary per item: no attempts, output or findings.
    const list = JSON.stringify(provider.snapshot());
    expect(list).not.toContain("secret log");
    expect(list).not.toContain("test failed");
    expect(Object.keys(provider.snapshot().verdicts[0]!)).toEqual([
      "itemId",
      "runId",
      "decision",
      "headSha",
      "checks",
    ]);
    const detail = provider.item("ENG-8")!;
    expect(detail.items.map((entry) => entry.id)).toEqual(["ENG-8"]);
    expect(detail.blocks).toEqual(["ENG-9"]);
    const attempts = detail.verdicts[0]!.attempts!;
    expect(attempts.map((attempt) => [attempt.decision, attempt.checks[0]?.findings])).toEqual([
      ["rejected", "test failed"],
      ["accepted", null],
    ]);
    expect(JSON.stringify(detail)).not.toContain("secret log");
    expect(provider.item("ENG-10")).toBeNull();
    expect(createLiveStatusProvider(db).item("ENG-10")?.id).toBe("ENG-10");

    const get = (id: string) =>
      handleStatusRequest(new Request(`http://127.0.0.1/api/status/items/${id}`), {
        db,
        sessionIds: ["ses_8"],
      });
    const response = (await get("ENG-8"))!;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe("ENG-8");
    expect((await get("ENG-10"))?.status).toBe(404);
    expect((await get("ENG-404"))?.status).toBe(404);
  });

  test("the item detail's risk block has the tier, each path's list and the security review", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "d".repeat(40);
    const head = "c".repeat(40);
    const item = insertQueuedItem(db, { id: "ENG-11", title: "Risk", sessionKey: "ses_11", now });
    const docs = insertQueuedItem(db, { id: "ENG-12", sessionKey: "ses_11", now });
    const provider = createLiveStatusProvider(db, { now: () => new Date(now + 5000) });
    expect(provider.item("ENG-11")?.risk).toBeNull();
    const identity = (taskId: string) => ({
      taskId,
      base,
      head,
      policyDigest: "sha256:policy",
      policyPath: ".agents/closeout.yaml",
    });
    const review = (state: CloseoutStepWrite["state"], detail: string | null) => ({
      id: "security-review",
      kind: "review" as const,
      state,
      command: "security-review",
      detail,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: now,
      finishedAt: now,
      exitCode: null,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: null,
      findings: null,
      ordinal: 0,
    });
    upsertCloseoutStep(db, item.id, identity(item.id), review("passed", null), now);
    finishCloseoutProgress(db, item.id, identity(item.id), "accepted", now);
    saveCandidateRisk(db, {
      itemId: item.id,
      head,
      base,
      tier: "high",
      paths: ["infra/main.tf", "src/auth/session.ts"],
      matches: [
        { path: "infra/main.tf", lists: ["file"] },
        { path: "src/auth/session.ts", lists: ["settings", "file"] },
      ],
      classifiedAt: now,
    });
    upsertCloseoutStep(
      db,
      docs.id,
      identity(docs.id),
      review("skipped", "no changed path matches"),
      now,
    );
    finishCloseoutProgress(db, docs.id, identity(docs.id), "accepted", now);
    saveCandidateRisk(db, {
      itemId: docs.id,
      head,
      base,
      tier: "normal",
      paths: [],
      matches: [],
      classifiedAt: now,
    });
    const high = parseStatusItemDetail(JSON.parse(JSON.stringify(provider.item("ENG-11"))));
    if (!high.ok) throw new Error(high.error);
    expect(high.detail.risk).toEqual({
      tier: "high",
      head,
      base,
      classifiedAt: new Date(now).toISOString(),
      paths: [
        { path: "infra/main.tf", lists: ["file"] },
        { path: "src/auth/session.ts", lists: ["settings", "file"] },
      ],
      securityReview: { state: "passed", detail: null, head },
    });
    expect(provider.item("ENG-12")?.risk).toMatchObject({
      tier: "normal",
      paths: [],
      securityReview: { state: "skipped", detail: "no changed path matches", head },
    });
  });

  test("a check log is read only for a check of that issue's Closeout attempt", async () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "d".repeat(40);
    const seed = (id: string, session: string, check: string, output: string) => {
      const item = insertQueuedItem(db, { id, sessionKey: session, now });
      beginImplementRun(db, item.id, now);
      enterMergeQueue(db, item.id, {
        phase: "merge_queue",
        baseSha: base,
        wipCommit: "c".repeat(40),
      });
      const identity = {
        taskId: item.id,
        base,
        head: "c".repeat(40),
        policyDigest: "sha256:policy",
        policyPath: null,
      };
      upsertCloseoutStep(
        db,
        item.id,
        identity,
        {
          id: check,
          kind: "command",
          state: "failed",
          command: "bun test",
          detail: null,
          attempt: 1,
          timeoutSeconds: null,
          startedAt: now,
          finishedAt: now,
          exitCode: 1,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath: null,
          findings: null,
          ordinal: 0,
        },
        now,
      );
      appendCloseoutOutput(db, item.id, identity, check, "stderr", output, false, now);
      appendCloseoutOutput(db, item.id, identity, check, "stdout", `${id} out`, false, now);
      finishCloseoutProgress(db, item.id, identity, "rejected", now);
    };
    seed("ENG-11", "ses_11", "unit", "unit failed");
    seed("ENG-12", "ses_11", "lint", "lint failed");
    seed("ENG-13", "ses_other", "unit", "hidden failure");
    const provider = createLiveStatusProvider(db, {
      now: () => new Date(now + 5000),
      sessionIds: ["ses_11"],
    });
    const request = (itemId: string, checkId: string, attempt = 1) => ({
      itemId,
      attempt,
      checkId,
      run: null,
    });
    expect(provider.checkLog(request("ENG-11", "unit"))).toEqual({
      stdout: "ENG-11 out",
      stderr: "unit failed",
    });
    // `lint` is a check of ENG-12, not of ENG-11.
    expect(provider.checkLog(request("ENG-11", "lint"))).toBeNull();
    expect(provider.checkLog(request("ENG-11", "unit", 2))).toBeNull();
    expect(provider.checkLog({ ...request("ENG-11", "unit"), run: "other-run" })).toBeNull();
    // Outside the reader's sessions, as if the issue did not exist.
    expect(provider.checkLog(request("ENG-13", "unit"))).toBeNull();

    const get = (path: string) =>
      handleStatusRequest(new Request(`http://127.0.0.1/api/status/items/${path}/log`), {
        db,
        sessionIds: ["ses_11"],
      });
    const mine = (await get("ENG-11/attempts/1/checks/unit"))!;
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({
      stdout: "ENG-11 out",
      stderr: "unit failed",
      truncated: false,
      fullPath: null,
    });
    const other = (await get("ENG-11/attempts/1/checks/lint"))!;
    const hidden = (await get("ENG-13/attempts/1/checks/unit"))!;
    expect(other.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("hidden failure");
  });

  test("a review keeps its measured duration and tokens when a later evaluation reads it again", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const item = insertQueuedItem(db, { id: "ENG-7", title: "Review", sessionKey: "ses_7", now });
    beginImplementRun(db, item.id, now);
    enterMergeQueue(db, item.id, {
      phase: "merge_queue",
      baseSha: "d".repeat(40),
      wipCommit: "c".repeat(40),
    });
    const identity = {
      taskId: item.id,
      base: "d".repeat(40),
      head: "c".repeat(40),
      policyDigest: "sha256:policy",
      policyPath: ".agents/closeout.yaml",
    };
    const review = (state: CloseoutStepWrite["state"], at: number, extra = {}) =>
      upsertCloseoutStep(
        db,
        item.id,
        identity,
        {
          id: "independent-review",
          kind: "review",
          state,
          command: "",
          detail: null,
          attempt: 1,
          timeoutSeconds: null,
          startedAt: state === "running" ? at : null,
          finishedAt: state === "running" ? null : at,
          exitCode: null,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath: null,
          findings: null,
          ordinal: -1,
          ...extra,
        },
        at,
      );
    review("running", now);
    review("passed", now + 200_000, { durationMs: 180_000, tokens: 52_000 });
    review("passed", now + 900_000);
    finishCloseoutProgress(db, item.id, identity, "accepted", now + 900_000);
    const check = createLiveStatusProvider(db, {
      now: () => new Date(now + 900_000),
    }).item("ENG-7")?.verdicts[0]?.checks[0];
    expect(check?.elapsedMs).toBe(180_000);
    expect(check?.tokens).toBe(52_000);
    review("running", now + 950_000);
    const rerun = createLiveStatusProvider(db, {
      now: () => new Date(now + 960_000),
    }).item("ENG-7")?.verdicts[0]?.checks[0];
    expect(rerun?.elapsedMs).toBe(10_000);
    expect(rerun?.tokens ?? null).toBeNull();
  });

  test("a re-check of a rebased head starts a new round of Closeout attempts", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "d".repeat(40);
    const item = insertQueuedItem(db, { id: "ENG-6", title: "Rebased", sessionKey: "ses_6", now });
    beginImplementRun(db, item.id, now);
    enterMergeQueue(db, item.id, {
      phase: "merge_queue",
      baseSha: base,
      wipCommit: "b".repeat(40),
    });
    const attempt = (head: string, at: number, state: "failed" | "passed") => {
      const identity = {
        taskId: item.id,
        base,
        head,
        policyDigest: "sha256:policy",
        policyPath: ".agents/closeout.yaml",
      };
      upsertCloseoutStep(
        db,
        item.id,
        identity,
        {
          id: "test",
          kind: "command",
          state,
          command: "bun test",
          detail: null,
          attempt: 1,
          timeoutSeconds: null,
          startedAt: at,
          finishedAt: at,
          exitCode: state === "passed" ? 0 : 1,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath: null,
          findings: null,
          ordinal: 0,
        },
        at,
      );
      finishCloseoutProgress(
        db,
        item.id,
        identity,
        state === "passed" ? "accepted" : "rejected",
        at,
      );
    };
    attempt("a".repeat(40), now, "failed");
    attempt("b".repeat(40), now + 1, "passed");
    startCloseoutRound(db, {
      itemId: item.id,
      head: "c".repeat(40),
      retryBaseline: ["a", "b"],
      startedAt: now + 2,
    });
    attempt("c".repeat(40), now + 3, "passed");
    const detail = createLiveStatusProvider(db, { now: () => new Date(now + 4) }).item("ENG-6");
    const attempts = detail?.verdicts.find((verdict) => verdict.itemId === "ENG-6")?.attempts;
    expect(attempts?.map((entry) => [entry.number, entry.round, entry.headSha?.[0]])).toEqual([
      [1, 1, "a"],
      [2, 1, "b"],
      [3, 2, "c"],
    ]);
    const parsed = parseStatusItemDetail(JSON.parse(JSON.stringify(detail)));
    expect(parsed.ok).toBe(true);
  });

  test("CI rounds carry every check on the head and the failing checks' log tails", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const item = insertQueuedItem(db, { id: "ENG-7", title: "CI", sessionKey: "ses_7", now });
    const { run } = beginImplementRun(db, item.id, now);
    const check = (
      name: string,
      state: "passed" | "failed" | "running" | "skipped",
      logTail: string | null = null,
    ) => ({
      name,
      state,
      url: `https://github.com/acme/app/runs/${name}`,
      startedAt: "2026-10-22T10:00:00Z",
      completedAt: state === "running" ? null : "2026-10-22T10:04:51Z",
      logTail,
      logSource: logTail === null ? null : ("actions" as const),
    });
    recordCiRound(db, {
      itemId: item.id,
      head: "a".repeat(40),
      runId: run.id,
      next: "agent",
      fix: 1,
      fixLimit: 3,
      checks: [
        check("lint", "passed"),
        check("test", "failed", "1 fail\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123"),
        check("e2e", "running"),
      ],
      recordedAt: now + 1,
    });
    recordCiRound(db, {
      itemId: item.id,
      head: "b".repeat(40),
      runId: run.id,
      next: "asked",
      fix: null,
      fixLimit: 3,
      checks: [
        check("lint", "passed"),
        check("test", "failed", "still 1 fail"),
        check("docs", "skipped"),
      ],
      recordedAt: now + 2,
    });
    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now + 3) }).snapshot();
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rounds = parsed.snapshot.ciRounds ?? [];
    expect(
      rounds.map((round) => [round.itemId, round.round, round.head[0], round.next, round.fix]),
    ).toEqual([
      ["ENG-7", 1, "a", "agent", 1],
      ["ENG-7", 2, "b", "asked", null],
    ]);
    expect(rounds[0]?.runId).toBe(run.id);
    expect(rounds[0]?.fixLimit).toBe(3);
    expect(rounds[0]?.recordedAt).toBe(new Date(now + 1).toISOString());
    expect(rounds[0]?.checks.map((entry) => [entry.name, entry.state, entry.completedAt])).toEqual([
      ["lint", "passed", "2026-10-22T10:04:51Z"],
      ["test", "failed", "2026-10-22T10:04:51Z"],
      ["e2e", "running", null],
    ]);
    expect(rounds[0]?.checks[1]).toMatchObject({
      url: "https://github.com/acme/app/runs/test",
      logSource: "actions",
      logTail: "1 fail\ntoken [redacted]",
    });
    expect(rounds[1]?.checks.map((entry) => entry.state)).toEqual(["passed", "failed", "skipped"]);
    expect(
      createLiveStatusProvider(db, { sessionIds: ["other"] }).snapshot().ciRounds ?? [],
    ).toEqual([]);
  });

  test.each([
    ["merged", "code", null, true],
    ["merged", "code", "merged-head", false],
    ["completed", "code", null, true],
    ["completed", "answer", null, false],
    ["completed", "artifact", null, false],
    ["cancelled", "code", null, true],
  ] as const)(
    "blocker %s in %s mode with merge SHA %s is named: %s",
    (state, mode, mergeSha, named) => {
      const db = database();
      const blocker = insertQueuedItem(db, { id: "PAS-709", now: 10 });
      const blocked = insertQueuedItem(db, { id: "PAS-710", now: 20 });
      db.run("UPDATE work_item SET state=? WHERE id=?", [state, blocker.id]);
      saveTaskMode(db, blocker.id, mode);
      if (mergeSha)
        recordConfirmedRemoteMerge(db, {
          itemId: blocker.id,
          repositoryOwner: "pmdroid",
          repositoryName: "paws-app",
          pullNumber: 1,
          pullUrl: null,
          mergeSha,
          confirmedAt: 30,
        });
      saveTaskBlocks(
        db,
        [blocked.linearIssueId],
        [
          {
            blockerLinearIssueId: blocker.linearIssueId,
            blockedLinearIssueId: blocked.linearIssueId,
          },
        ],
      );
      const snapshot = createLiveStatusProvider(db).snapshot();
      const item = snapshot.items.find((entry) => entry.id === "PAS-710")!;
      expect(item.blockers).toEqual(named ? ["PAS-709"] : []);
      expect(waitReason(item)).toBe(named ? "Blocked by PAS-709" : "Waiting for a free runner");
    },
  );

  test("task blocks use the latest item on a Linear issue and skip issues with no item", () => {
    const db = database();
    const older = insertQueuedItem(db, { id: "older", title: "Old", now: 10 });
    const newer = insertQueuedItem(db, { id: "newer", title: "New", now: 20 });
    const blocked = insertQueuedItem(db, { id: "blocked", title: "Blocked", now: 30 });
    db.run("UPDATE work_item SET state = 'completed', linear_identifier = 'ENG-OLD' WHERE id = ?", [
      older.id,
    ]);
    db.run("UPDATE work_item SET linear_issue_id = ?, linear_identifier = 'ENG-NEW' WHERE id = ?", [
      older.linearIssueId,
      newer.id,
    ]);
    db.run("UPDATE work_item SET linear_identifier = 'ENG-BLOCK' WHERE id = ?", [blocked.id]);
    saveTaskBlocks(
      db,
      [blocked.linearIssueId],
      [
        {
          blockerLinearIssueId: older.linearIssueId,
          blockedLinearIssueId: blocked.linearIssueId,
        },
        {
          blockerLinearIssueId: "lin-missing",
          blockedLinearIssueId: blocked.linearIssueId,
        },
      ],
    );
    const snapshot = createLiveStatusProvider(db, { now: () => new Date(30) }).snapshot();
    expect(snapshot.items.find((item) => item.id === "ENG-BLOCK")?.blockers).toEqual(["ENG-NEW"]);
    expect(snapshot.items.some((item) => item.id === "ENG-OLD")).toBe(true);
    expect(statusIntegrity(snapshot)).toEqual([]);
  });

  test("the serving database is the single source despite retired overrides", async () => {
    const db = database();
    insertQueuedItem(db, { id: "ENG-9", title: "Hang", now: 1 });
    const live = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const liveBody = (await live?.json()) as { source: string; items: Array<{ id: string }> };
    expect(liveBody.source).toBe("live");
    expect(liveBody.items.map((item) => item.id)).toEqual(["ENG-9"]);

    const query = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status?engine=demo"),
      { db, env: {} },
    );
    const queryBody = (await query?.json()) as { source: string; items: Array<{ id: string }> };
    expect(queryBody.source).toBe("live");
    expect(queryBody.items.map((item) => item.id)).toEqual(["ENG-9"]);

    const flagged = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: { PAWS_STATUS_DEMO: "1" },
    });
    const flaggedBody = (await flagged?.json()) as { source: string };
    expect(flaggedBody.source).toBe("live");
  });
  test("intake queue and Linear budget come from the inbox and the ledger, scoped to the session", async () => {
    const db = database();
    const event = (key: string, session: string, received: number, payload: object, extra = "") =>
      db.run(
        `INSERT INTO inbox_event (dedupe_key, source, action, session_id, issue_id, signal, updated_at_ms, payload, received_at${extra ? ", attempts, next_attempt_at, last_error" : ""}) VALUES (?, 'webhook', 'created', ?, ?, NULL, 1, ?, ?${extra})`,
        [key, session, `issue-${key}`, JSON.stringify(payload), received],
      );
    event(
      "a",
      "s1",
      1_000,
      { agentSession: { issue: { identifier: "ENG-1", title: "First" } } },
      ", 2, 90000, 'Linear GraphQL: RATELIMITED'",
    );
    event("b", "s2", 2_000, { kind: "session" });
    db.run(
      "INSERT INTO inbox_event (dedupe_key, source, action, session_id, updated_at_ms, payload, received_at, handled) VALUES ('done', 'webhook', 'created', 's1', 1, '{}', 500, 1)",
    );
    db.run(
      "INSERT INTO inbox_event (dedupe_key, source, action, session_id, signal, updated_at_ms, payload, received_at) VALUES ('stop', 'webhook', 'prompted', 's1', 'stop', 1, '{}', 600)",
    );
    const usage = () => ({
      budget: { requestsRemaining: 0, requestsLimit: 1500, requestsResetMs: 3_600_000 },
      holdUntilMs: 300_000,
    });
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
      linearUsage: usage,
    });
    const parsed = parseStatusSnapshot(await response!.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.items).toEqual([]);
    expect(parsed.snapshot.intake).toEqual([
      {
        issue: "ENG-1",
        title: "First",
        receivedAt: new Date(1_000).toISOString(),
        attempts: 2,
        nextAttemptAt: new Date(90_000).toISOString(),
        lastError: "Linear GraphQL: RATELIMITED",
      },
      {
        issue: "issue-b",
        title: null,
        receivedAt: new Date(2_000).toISOString(),
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      },
    ]);
    expect(parsed.snapshot.linearBudget).toEqual({
      requestsRemaining: 0,
      requestsLimit: 1500,
      resetAt: new Date(3_600_000).toISOString(),
      holdUntil: new Date(300_000).toISOString(),
    });
    const scoped = createLiveStatusProvider(db, { sessionIds: ["s2"] }).snapshot();
    expect(scoped.intake?.map((entry) => entry.issue)).toEqual(["issue-b"]);
    expect(scoped.linearBudget).toBeUndefined();
  });

  test("the Intake section carries the warning when Linear may have disabled the webhook", () => {
    const db = database();
    const snapshot = (atMs: number) =>
      createLiveStatusProvider(db, { now: () => new Date(atMs) }).snapshot();
    expect(snapshot(10_000).linearWebhook).toBeUndefined();
    db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('linear:webhook', 1000)");
    expect(snapshot(10_000).linearWebhook).toBeUndefined();
    db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('linear:webhook-missed', 5000)");
    expect(snapshot(10_000).linearWebhook).toEqual({
      warning:
        "Linear may have disabled the Paws webhook: the catch-up poll found events no webhook delivered.",
      fix: LINEAR_WEBHOOK_FIX,
      lastVerifiedAt: new Date(1000).toISOString(),
    });
  });
});
