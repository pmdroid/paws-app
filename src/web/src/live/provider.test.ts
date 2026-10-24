import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  enqueueOutbox,
  enterMergeQueue,
  finishCloseoutProgress,
  insertQueuedItem,
  LINEAR_WEBHOOK_FIX,
  joinMergeQueue,
  keepTaskMergeSettings,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordCiRound,
  recordConfirmedRemoteMerge,
  saveEvidence,
  saveTaskBlocks,
  startCloseoutRound,
  upsertCloseoutStep,
  type CloseoutStepWrite,
} from "../../../db";
import { parseStatusSnapshot, statusIntegrity } from "../contract";
import { handleStatusRequest, startStatusServer } from "../engine";
import { createLiveStatusProvider } from "./provider";

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
      lane: "merge",
      jobKey: `merge:${merging.id}:${head}`,
      payload: { itemId: merging.id, summary: `${summary}\nCaller attempt: 2`, head },
      now,
    });

    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now) }).snapshot();
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
    expect(verdict?.baseSha).toBe(base);
    expect(verdict?.headSha).toBe(head);
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
        lane: "merge",
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
    }).snapshot().verdicts[0]?.checks[0];
    expect(check?.elapsedMs).toBe(180_000);
    expect(check?.tokens).toBe(52_000);
    review("running", now + 950_000);
    const rerun = createLiveStatusProvider(db, {
      now: () => new Date(now + 960_000),
    }).snapshot().verdicts[0]?.checks[0];
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
    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now + 4) }).snapshot();
    const attempts = snapshot.verdicts.find((verdict) => verdict.itemId === "ENG-6")?.attempts;
    expect(attempts?.map((entry) => [entry.number, entry.round, entry.headSha?.[0]])).toEqual([
      [1, 1, "a"],
      [2, 1, "b"],
      [3, 2, "c"],
    ]);
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
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

  test("demo is opt-in and does not replace a live database unless asked", async () => {
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
    expect(queryBody.source).toBe("demo");
    expect(queryBody.items.some((item) => item.id === "ENG-9")).toBe(false);

    const flagged = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: { PAWS_STATUS_DEMO: "1" },
    });
    const flaggedBody = (await flagged?.json()) as { source: string };
    expect(flaggedBody.source).toBe("demo");
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
