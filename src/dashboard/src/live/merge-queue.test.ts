import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  appendCloseoutOutput,
  beginImplementRun,
  enqueueOutbox,
  enterMergeQueue,
  finishCloseoutProgress,
  insertQueuedItem,
  joinMergeQueue,
  migrate,
  openDatabase,
  recordPushOutage,
  savePolicyRunnerWarning,
  upsertCloseoutStep,
} from "../../../db";
import { parseMergeQueueResponse } from "../contract";
import { createLiveStatusProvider } from "./provider";

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const DETAIL_TABLES = [
  "closeout_step",
  "closeout_progress",
  "closeout_round",
  "agent_closeout_event",
  "evidence",
  "question",
  "runner_transcript",
  "runner_transcript_chunk",
  "ci_round",
  "candidate_risk",
  "review_finding",
  "visual_review",
];

function recordQueries(db: Database): string[] {
  const seen: string[] = [];
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db);
  db.query = ((sql: string) => (seen.push(sql), query(sql))) as typeof db.query;
  db.prepare = ((sql: string) => (seen.push(sql), prepare(sql))) as typeof db.prepare;
  return seen;
}

function queued(db: Database, id: string, session: string, at: number) {
  const head = "c".repeat(40);
  const item = insertQueuedItem(db, { id, title: `Title ${id}`, sessionKey: session, now: at });
  beginImplementRun(db, item.id, at);
  enterMergeQueue(db, item.id, { phase: "merge_queue", baseSha: head, wipCommit: head });
  enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: session,
    idempotencyKey: `${item.id}:pr:${at}`,
    payload: {
      sessionId: session,
      kind: "response",
      body: `Opened https://github.com/acme/platform/pull/${at}.`,
    },
    now: at,
  });
  joinMergeQueue(db, { itemId: item.id, repository: "acme/platform", now: at * 10 });
  const identity = {
    taskId: item.id,
    base: head,
    head,
    policyDigest: "sha256:p",
    policyPath: null,
  };
  upsertCloseoutStep(
    db,
    item.id,
    identity,
    {
      id: "test",
      kind: "command",
      state: "failed",
      command: "bun test",
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: at,
      finishedAt: at,
      exitCode: 1,
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
  appendCloseoutOutput(db, item.id, identity, "test", "stderr", "check output", false, at);
  finishCloseoutProgress(db, item.id, identity, "accepted", at);
}

test("the merge queue reads queue facts, issue summaries and banners for the reader's sessions only", async () => {
  const db = openDatabase(":memory:");
  open.push(db);
  migrate(db);
  const now = Date.now();
  queued(db, "ENG-1", "ses_mine", 1);
  queued(db, "ENG-2", "ses_mine", 2);
  queued(db, "ENG-3", "ses_other", 3);
  insertQueuedItem(db, { id: "ENG-4", title: "Not merging", sessionKey: "ses_mine", now: 4 });
  recordPushOutage(db, {
    repository: "acme/platform",
    error: "denied",
    jobId: null,
    installationUrl: null,
    now,
    delayMs: () => 60_000,
  });
  savePolicyRunnerWarning(db, {
    repository: "acme/platform",
    policyDigest: `sha256:${"a".repeat(64)}`,
    runnerVersion: "0.1.48",
    keys: [{ key: "items[].ci", needs: "0.1.49" }],
    checkedAt: now,
  });
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','org','W',0)",
  );
  db.run(
    "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('w','acme/platform','team')",
  );
  db.run(
    `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
      installation_observed_at, created_at) VALUES ('ses_mine', 'org', 'fixture', 'app', 'team', 1, 0)`,
  );

  const seen = recordQueries(db);
  const provider = createLiveStatusProvider(db, { sessionIds: ["ses_mine"], env: {} });
  const parsed = parseMergeQueueResponse(JSON.parse(JSON.stringify(await provider.mergeQueue())));
  if (!parsed.ok) throw new Error(parsed.error);
  const queue = parsed.response;

  expect(queue.entries.map((entry) => [entry.position, entry.itemId, entry.waitingFor])).toEqual([
    [1, "ENG-1", "ci"],
    [2, "ENG-2", "ahead"],
  ]);
  expect(queue.entries[1]?.detail).toBe("Starts when #1 merges");
  expect(queue.issues).toEqual([
    {
      id: "ENG-2",
      title: "Title ENG-2",
      owner: null,
      project: null,
      pr: { number: 2, url: "https://github.com/acme/platform/pull/2" },
    },
    {
      id: "ENG-1",
      title: "Title ENG-1",
      owner: null,
      project: null,
      pr: { number: 1, url: "https://github.com/acme/platform/pull/1" },
    },
  ]);
  expect(queue.pushOutages.map((outage) => outage.repository)).toEqual(["acme/platform"]);
  expect(queue.policyRunnerWarnings.map((warning) => warning.runnerVersion)).toEqual(["0.1.48"]);
  expect(JSON.stringify(queue)).not.toContain("check output");
  const reads = seen.join("\n");
  for (const table of DETAIL_TABLES) expect(reads).not.toMatch(new RegExp(`\\b${table}\\b`));
  seen.length = 0;
  await provider.issue("ENG-1");
  expect(seen.join("\n")).toMatch(/\bcloseout_step\b/);
});
