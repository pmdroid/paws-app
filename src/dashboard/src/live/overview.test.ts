import { afterEach, describe, expect, test } from "bun:test";
import {
  appendCloseoutOutput,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  enterMergeQueue,
  insertLinkAsk,
  insertQueuedItem,
  saveCandidateRisk,
  upsertCloseoutStep,
  type Db,
} from "../../../db";
import { parseOverviewResponse, type OverviewResponse } from "../contract";
import { render } from "../client/render";
import { LINK_ASK_ANCHORS } from "../client/link-ask";
import { createLiveStatusProvider } from "./provider";
import { seed, withoutForeignKeys } from "../../../../test/dialects";
import { tempStore } from "../../../../test/pglite";
import { queriesDuring } from "../../../../test/query-log";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function database() {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

async function fixture(): Promise<Db> {
  const db = await database();
  await insertQueuedItem(db, { id: "ENG-1", title: "Queued", sessionKey: "s1", now: NOW - 9_000 });
  await insertQueuedItem(db, { id: "ENG-2", title: "Running", sessionKey: "s1", now: NOW - 8_000 });
  await beginImplementRun(db, "ENG-2", NOW - 7_900);
  const identity = { taskId: "ENG-2", base: "b".repeat(40), head: HEAD, policyDigest: "sha256:p" };
  await upsertCloseoutStep(
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
  await appendCloseoutOutput(
    db,
    "ENG-2",
    { ...identity, policyPath: null },
    "test",
    "stderr",
    "check output that only the issue page reads",
    false,
    NOW - 6_900,
  );
  await insertQueuedItem(db, { id: "ENG-3", title: "Merging", sessionKey: "s1", now: NOW - 7_000 });
  await beginImplementRun(db, "ENG-3", NOW - 6_900);
  await enterMergeQueue(db, "ENG-3", {
    phase: "merge_queue",
    baseSha: "b".repeat(40),
    wipCommit: "c".repeat(40),
  });
  await insertQueuedItem(db, { id: "ENG-4", title: "Risky", sessionKey: "s1", now: NOW - 6_000 });
  await beginImplementRun(db, "ENG-4", NOW - 5_900);
  await applyWorkItemEvent(db, "ENG-4", "blocking_question");
  await seed(db, (q) =>
    q.orm.insert(q.t.question).values({
      id: "q-risk",
      itemId: "ENG-4",
      sessionId: "s1",
      kind: "link",
      body: "High-risk changes",
      status: "open",
      createdAt: NOW - 5_000,
    }),
  );
  await insertLinkAsk(db, {
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
  await saveCandidateRisk(db, {
    itemId: "ENG-4",
    head: HEAD,
    base: "base",
    tier: "high",
    paths: ["src/auth/session.ts"],
    classifiedAt: NOW - 5_000,
  });
  await insertQueuedItem(db, {
    id: "ENG-5",
    title: "Held review",
    sessionKey: "s1",
    now: NOW - 4_000,
  });
  await beginImplementRun(db, "ENG-5", NOW - 3_900);
  await applyWorkItemEvent(db, "ENG-5", "turn_ended");
  await enqueueJob(db, {
    queue: "run.reverify",
    payload: { itemId: "ENG-5", reviewerFault: "reviewer-key" },
    runAt: NOW + 900_000,
    now: NOW - 3_000,
  });
  for (const [index, id] of ["ENG-6", "ENG-7"].entries()) {
    await insertQueuedItem(db, {
      id,
      title: `Stopped ${index}`,
      sessionKey: "s1",
      now: NOW - 2_000,
    });
    await applyWorkItemEvent(db, id, "cancel", { now: NOW - 1_000 });
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
    const attention = html.slice(html.indexOf('id="attention-heading"')).split("</section>")[0]!;
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
    expect(section(html, "work-heading", "attention-heading")).toContain("ENG-5");
  });

  test("reads no check output, evidence, CI rounds, agent Closeout or merge queue detail", async () => {
    const db = await fixture();
    const live = createLiveStatusProvider(db, { now: () => new Date(NOW), env: {} });
    let body = "";
    const overview = await queriesDuring(db, async () => {
      body = JSON.stringify(await live.overview());
    });
    // The issue pages and the merge queue do read those tables.
    const detail = await queriesDuring(db, async () => {
      for (const issue of (await live.issues()).issues) await live.issue(issue.id);
      await live.mergeQueue();
    });
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
    await insertQueuedItem(db, { id: "ENG-9", title: "Elsewhere", sessionKey: "s2", now: NOW });
    const mine = await createLiveStatusProvider(db, {
      now: () => new Date(NOW),
      env: {},
      sessionIds: ["s2"],
    }).overview();
    expect(mine.issues.map((issue) => issue.id)).toEqual(["ENG-9"]);
    expect(mine.questions).toEqual([]);
    expect(mine.mergeQueueCount).toBe(0);
  });

  test("setup reads which first-run steps are done", async () => {
    const db = await database();
    const read = () =>
      createLiveStatusProvider(db, { now: () => new Date(NOW), env: {} }).overview();
    expect((await read()).setup).toEqual({
      github: false,
      runner: false,
      agent: false,
      delegated: false,
    });
    await withoutForeignKeys(db);
    const runner = { workspaceId: "ws", ownerUserId: "owner", status: "active", createdAt: 0 };
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workspaceGithubConnection).values({
          workspaceId: "ws",
          generation: 1,
          secretId: "secret-1",
          installationId: "42",
          repositories: '["pmdroid/paws-app"]',
        }),
      (q) =>
        q.orm.insert(q.t.runner).values([
          { ...runner, id: "box", name: "box" },
          { ...runner, id: "old", name: "old", status: "revoked", revokedAt: 1 },
        ]),
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: "old", agent: "claude", ready: 1 }),
    );
    expect((await read()).setup).toEqual({
      github: true,
      runner: true,
      agent: false,
      delegated: false,
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: "box", agent: "claude", ready: 1 }),
    );
    await insertQueuedItem(db, { id: "ENG-1", title: "First", sessionKey: "s1", now: NOW });
    expect((await read()).setup).toEqual({
      github: true,
      runner: true,
      agent: true,
      delegated: true,
    });
  });

  test("the parser rejects an overview without setup", async () => {
    const db = await database();
    const body = JSON.parse(
      JSON.stringify(await createLiveStatusProvider(db, { env: {} }).overview()),
    );
    expect(parseOverviewResponse(body).ok).toBe(true);
    delete body.setup;
    expect(parseOverviewResponse(body).ok).toBe(false);
  });
});
