import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  appendCloseoutOutput,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  enterMergeQueue,
  insertLinkAsk,
  insertQueuedItem,
  migrate,
  openDatabase,
  saveCandidateRisk,
  upsertCloseoutStep,
  sqliteDb,
} from "../../../db";
import { parseOverviewResponse, type OverviewResponse } from "../contract";
import { render } from "../client/render";
import { LINK_ASK_ANCHORS } from "../client/link-ask";
import { createLiveStatusProvider } from "./provider";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

async function fixture(): Promise<Database> {
  const db = database();
  insertQueuedItem(db, { id: "ENG-1", title: "Queued", sessionKey: "s1", now: NOW - 9_000 });
  insertQueuedItem(db, { id: "ENG-2", title: "Running", sessionKey: "s1", now: NOW - 8_000 });
  beginImplementRun(db, "ENG-2", NOW - 7_900);
  const identity = { taskId: "ENG-2", base: "b".repeat(40), head: HEAD, policyDigest: "sha256:p" };
  upsertCloseoutStep(
    db,
    "ENG-2",
    { ...identity, policyPath: null },
    {
      id: "test",
      kind: "command",
      state: "failed",
      command: "bun test",
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: NOW - 7_000,
      finishedAt: NOW - 6_900,
      exitCode: 1,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: null,
      findings: null,
      ordinal: 0,
    },
    NOW - 6_900,
  );
  appendCloseoutOutput(
    db,
    "ENG-2",
    { ...identity, policyPath: null },
    "test",
    "stderr",
    "check output that only the issue page reads",
    false,
    NOW - 6_900,
  );
  insertQueuedItem(db, { id: "ENG-3", title: "Merging", sessionKey: "s1", now: NOW - 7_000 });
  beginImplementRun(db, "ENG-3", NOW - 6_900);
  enterMergeQueue(db, "ENG-3", {
    phase: "merge_queue",
    baseSha: "b".repeat(40),
    wipCommit: "c".repeat(40),
  });
  insertQueuedItem(db, { id: "ENG-4", title: "Risky", sessionKey: "s1", now: NOW - 6_000 });
  beginImplementRun(db, "ENG-4", NOW - 5_900);
  applyWorkItemEvent(db, "ENG-4", "blocking_question");
  db.run(
    "INSERT INTO question (id, item_id, session_id, kind, body, status, created_at) VALUES ('q-risk', 'ENG-4', 's1', 'link', 'High-risk changes', 'open', ?)",
    [NOW - 5_000],
  );
  await insertLinkAsk(sqliteDb(db), {
    questionId: "q-risk",
    itemId: "ENG-4",
    kind: "risk",
    headCommit: HEAD,
    link: "https://paws.example/status/issues/ENG-4#risk",
    title: "High-risk changes in 7f65200 need your approval.",
    detail: "High-risk paths changed: `src/auth/session.ts`.",
    answerers: ["delegator"],
    createdAt: NOW - 5_000,
  });
  saveCandidateRisk(db, {
    itemId: "ENG-4",
    head: HEAD,
    base: "base",
    tier: "high",
    paths: ["src/auth/session.ts"],
    classifiedAt: NOW - 5_000,
  });
  insertQueuedItem(db, { id: "ENG-5", title: "Held review", sessionKey: "s1", now: NOW - 4_000 });
  beginImplementRun(db, "ENG-5", NOW - 3_900);
  applyWorkItemEvent(db, "ENG-5", "turn_ended");
  enqueueJob(db, {
    queue: "run.reverify",
    payload: { itemId: "ENG-5", reviewerFault: "reviewer-key" },
    runAt: NOW + 900_000,
    now: NOW - 3_000,
  });
  for (const [index, id] of ["ENG-6", "ENG-7"].entries()) {
    insertQueuedItem(db, { id, title: `Stopped ${index}`, sessionKey: "s1", now: NOW - 2_000 });
    applyWorkItemEvent(db, id, "cancel", { now: NOW - 1_000 });
  }
  return db;
}

function overviewHtml(overview: OverviewResponse): string {
  return render({
    route: { view: "overview" },
    phase: "ready",
    overview,
    error: null,
    engineUrl: null,
  }).content;
}

function section(html: string, heading: string, next: string): string {
  return html.slice(html.indexOf(`id="${heading}"`), html.indexOf(`id="${next}"`));
}

function recordSql(db: Database): string[] {
  const statements: string[] = [];
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db);
  db.query = ((sql: string) => (statements.push(sql), query(sql))) as typeof db.query;
  db.prepare = ((sql: string) => (statements.push(sql), prepare(sql))) as typeof db.prepare;
  return statements;
}

describe("overview resource", () => {
  test("draws Overview from its own resource", async () => {
    const db = await fixture();
    const live = createLiveStatusProvider(db, { now: () => new Date(NOW), env: {} });
    const parsed = parseOverviewResponse(JSON.parse(JSON.stringify(await live.overview())));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(overviewHtml(parsed.response)).toContain('id="attention-heading"');
    expect(parsed.response.issues.map((issue) => issue.id)).toEqual([
      "ENG-5",
      "ENG-4",
      "ENG-3",
      "ENG-2",
      "ENG-1",
    ]);
    expect(parsed.response.mergeQueueCount).toBe(1);
    expect(parsed.response.issues.find((issue) => issue.id === "ENG-2")?.verdict?.decision).toBe(
      (await live.issues()).verdicts.find((verdict) => verdict.itemId === "ENG-2")?.decision,
    );
  });

  test("keeps the risk decision card anchor and does not call a held reviewer check failed", async () => {
    const db = await fixture();
    const overview = await createLiveStatusProvider(db, {
      now: () => new Date(NOW),
      env: {},
    }).overview();
    const html = overviewHtml(overview);
    const attention = section(html, "attention-heading", "work-heading");
    expect(attention).toContain(`/issues/ENG-4#${LINK_ASK_ANCHORS.risk}`);
    expect(overview.questions).toEqual([
      {
        id: "q-risk",
        itemId: "ENG-4",
        title: "High-risk changes in 7f65200 need your approval.",
        linkAsk: {
          kind: "risk",
          title: "High-risk changes in 7f65200 need your approval.",
          detail: "High-risk paths changed: `src/auth/session.ts`.",
        },
      },
    ]);
    expect(overview.issues.find((issue) => issue.id === "ENG-5")).toMatchObject({
      state: "verifying",
      verdict: { decision: "running" },
    });
    expect(attention).not.toContain("ENG-5");
    expect(section(html, "work-heading", "queued-heading")).toContain("ENG-5");
  });

  test("reads no check output, evidence, CI rounds, agent Closeout or merge queue detail", async () => {
    const db = await fixture();
    const statements = recordSql(db);
    const live = createLiveStatusProvider(db, { now: () => new Date(NOW), env: {} });
    const body = JSON.stringify(await live.overview());
    const overview = statements.splice(0);
    // The issue pages and the merge queue do read those tables.
    for (const issue of (await live.issues()).issues) await live.issue(issue.id);
    await live.mergeQueue();
    const detail = statements.splice(0);
    // A whole closeout_step row, as raw SQL or as Drizzle writes it.
    const wholeStep = /SELECT \* FROM closeout_step|"stdout".* from "closeout_step"/s;
    const unrelated = [
      wholeStep,
      /\bstdout\b/,
      /FROM "?evidence\b/i,
      /FROM "?ci_round\b/i,
      /FROM "?agent_closeout_event\b/i,
      /FROM "?closeout_round\b/i,
      /FROM "?run_agent_setup\b/i,
      /FROM "?visual_review_mark\b/i,
      /FROM "?work_item_merge_settings\b/i,
    ];
    for (const pattern of unrelated)
      expect(overview.filter((sql) => pattern.test(sql))).toEqual([]);
    expect(detail.some((sql) => wholeStep.test(sql))).toBe(true);
    expect(detail.some((sql) => /FROM "?agent_closeout_event\b/i.test(sql))).toBe(true);
    expect(detail.some((sql) => /FROM "?work_item_merge_settings\b/i.test(sql))).toBe(true);
    expect(overview.length).toBeLessThan(detail.length);
    expect(body).not.toContain("check output that only the issue page reads");
  });

  test("lists only the reader's sessions", async () => {
    const db = await fixture();
    insertQueuedItem(db, { id: "ENG-9", title: "Elsewhere", sessionKey: "s2", now: NOW });
    const mine = await createLiveStatusProvider(db, {
      now: () => new Date(NOW),
      env: {},
      sessionIds: ["s2"],
    }).overview();
    expect(mine.issues.map((issue) => issue.id)).toEqual(["ENG-9"]);
    expect(mine.questions).toEqual([]);
    expect(mine.mergeQueueCount).toBe(0);
  });
});
