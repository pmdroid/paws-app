import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  sqliteDb,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  enqueueOutbox,
  insertQueuedItem,
  insertRun,
  migrate,
  openDatabase,
  setCurrentRun,
} from "../../../db";
import {
  parseIssueDetailResponse,
  parseIssueListResponse,
  statusIntegrity,
  type IssueDetailResponse,
  type StatusDeadDelivery,
  type StatusItem,
  type StatusRun,
} from "../contract";
import { openedView } from "../../test/fixtures";
import { render } from "../client/render";
import { issueListRedirect, parseRoute } from "../client/route";
import { createLiveStatusProvider } from "./provider";

const ITEM = "01M5NDWPQZ0JQ91E1MFMVEY6EP";
const EARLIER = "01M5NAAAAZ0JQ91E1MFMVEY6EP";
const SESSION = "6f1c2f4e-2a51-4c1e-9d8e-3c5b1f0a7e21";
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const T0 = Date.parse("2026-10-24T20:00:00.000Z");

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

function identify(db: Database, id: string, identifier: string, issueId = "lin-367"): void {
  db.run("UPDATE work_item SET linear_identifier = ?, linear_issue_id = ? WHERE id = ?", [
    identifier,
    issueId,
    id,
  ]);
}

async function activity(
  db: Database,
  runId: string,
  sessionId: string,
  body: string,
  at: number,
): Promise<void> {
  await enqueueOutbox(sqliteDb(db), {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    idempotencyKey: `${runId}:${at}`,
    payload: { sessionId, kind: "thought", body },
    now: at,
  });
}

/** PAS-367 after a restart and a reply: three engine runs, each with one agent turn. */
async function threeRuns(db: Database): Promise<string[]> {
  insertQueuedItem(db, {
    id: ITEM,
    title: "Keep runs across restart",
    sessionKey: SESSION,
    now: T0,
  });
  identify(db, ITEM, "PAS-367");
  const first = (await beginImplementRun(sqliteDb(db), ITEM, T0 + 1_000)).run;
  const second = await insertRun(sqliteDb(db), { itemId: ITEM, now: T0 + 60_000, agent: "claude" });
  const third = await insertRun(sqliteDb(db), { itemId: ITEM, now: T0 + 120_000, agent: "claude" });
  await setCurrentRun(sqliteDb(db), ITEM, third.id);
  await activity(db, first.id, SESSION, "First turn read the issue.", T0 + 2_000);
  await activity(db, second.id, SESSION, "Second turn after the restart.", T0 + 61_000);
  await activity(
    db,
    third.id,
    SESSION,
    `Closeout: rejected\nTask: PAS-367-${ITEM}\nThird turn after the reply.`,
    T0 + 121_000,
  );
  return [first.id, second.id, third.id];
}

/**
 * The issue list's runs, with each listed issue's page as it loads it: `items` are every
 * session of those issues and `dead` their stopped deliveries.
 */
type Status = {
  items: StatusItem[];
  runs: StatusRun[];
  dead: StatusDeadDelivery[];
  details: Map<string, IssueDetailResponse>;
};

async function snapshotOf(db: Database): Promise<Status> {
  const provider = createLiveStatusProvider(db, {
    now: () => new Date(T0 + 300_000),
    env: {},
  });
  const parsed = parseIssueListResponse(JSON.parse(JSON.stringify(await provider.issues())));
  if (!parsed.ok) throw new Error(parsed.error);
  const list = parsed.response;
  const details = new Map<string, IssueDetailResponse>();
  for (const item of list.issues) {
    const detail = parseIssueDetailResponse(
      JSON.parse(JSON.stringify(await provider.issue(item.id))),
    );
    if (!detail.ok) throw new Error(detail.error);
    details.set(item.id, detail.response);
  }
  const pages = [...details.values()];
  const items = pages.flatMap((page) => [page.issue, ...page.earlierSessions]);
  expect(
    statusIntegrity({
      items,
      runs: list.runs,
      questions: [],
      verdicts: list.verdicts,
      mergeQueue: [],
    }),
  ).toEqual([]);
  return { items, runs: list.runs, dead: pages.flatMap((page) => page.dead), details };
}

function issuePage(snapshot: Status, id = "PAS-367"): string {
  const route = parseRoute(`/issues/${id}`);
  return render({
    route,
    phase: "ready",
    issue: route?.view === "issues" && route.id ? (snapshot.details.get(route.id) ?? null) : null,
    error: null,
    engineUrl: null,
    closeout: openedView(),
  }).content;
}

/** What a reader sees: the text between tags, with attributes and markup removed. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("one page per issue", () => {
  test("a task with three engine runs renders one issue page with one timeline holding all three in order", async () => {
    const db = database();
    await threeRuns(db);
    const snapshot = await snapshotOf(db);
    expect(snapshot.runs).toHaveLength(1);
    const html = issuePage(snapshot);
    expect(html.match(/<article /g)).toHaveLength(1);
    expect(html.match(/class="log"/g)).toHaveLength(1);
    const timeline = html.slice(html.indexOf('id="activity-heading"'));
    const turns = [
      "First turn read the issue.",
      "Second turn after the restart.",
      "Third turn after the reply.",
    ].map((text) => timeline.indexOf(text));
    expect(turns.every((at) => at > 0)).toBe(true);
    expect([...turns].sort((a, b) => a - b)).toEqual(turns);
    expect(timeline.match(/Implementation started with/g)).toHaveLength(3);
  });

  test("an old Conversations URL resolves to the issue page from stored records", async () => {
    const db = database();
    await threeRuns(db);
    const provider = createLiveStatusProvider(db, { env: {} });
    expect(parseRoute(`/sessions/${encodeURIComponent(SESSION)}`)).toEqual({
      view: "alias",
      kind: "sessions",
      id: SESSION,
    });
    expect(await provider.alias("sessions", SESSION)).toBe("PAS-367");
    expect(await provider.alias("sessions", "unknown-session")).toBeNull();
    expect(issueListRedirect("/sessions")).toBe("/issues");
    expect(issueListRedirect(`/sessions/${SESSION}`)).toBeNull();
  });

  test("run, session and verdict links resolve to PAS-367", async () => {
    const db = database();
    const runIds = await threeRuns(db);
    const provider = createLiveStatusProvider(db, { env: {} });
    for (const id of runIds) expect(await provider.alias("runs", id)).toBe("PAS-367");
    expect(await provider.alias("verdicts", "PAS-367")).toBe("PAS-367");
    expect(await provider.alias("verdicts", runIds[0]!)).toBe("PAS-367");
    expect(await provider.alias("verdicts", "PAS-404")).toBeNull();
    expect(parseRoute(`/runs/${runIds[1]}/transcript`)).toEqual({ view: "overview" });
    expect(issueListRedirect("/issues/PAS-367")).toBeNull();
    for (const list of ["/runs", "/sessions", "/verdicts"])
      expect(issueListRedirect(list)).toBe("/issues");
  });

  test("a re-delegated issue shows only the current Linear session on its page", async () => {
    const db = database();
    insertQueuedItem(db, {
      id: EARLIER,
      title: "Keep runs",
      sessionKey: "earlier-session",
      now: 0,
    });
    identify(db, EARLIER, "PAS-367");
    const old = (await beginImplementRun(sqliteDb(db), EARLIER, T0 - 7_200_000)).run;
    await activity(db, old.id, "earlier-session", "Earlier session turn.", T0 - 7_100_000);
    db.run("UPDATE work_item SET state = 'cancelled' WHERE id = ?", [EARLIER]);
    db.run("UPDATE run SET status = 'ended', updated_at = ? WHERE id = ?", [
      T0 - 3_600_000,
      old.id,
    ]);
    await threeRuns(db);
    const snapshot = await snapshotOf(db);
    const earlier = snapshot.items.find((item) => item.session?.id === "earlier-session");
    expect(earlier?.endedAt).toBe(new Date(T0 - 3_600_000).toISOString());
    expect(snapshot.items.find((item) => item.session?.id === SESSION)?.endedAt).toBeUndefined();

    const html = issuePage(snapshot);
    expect(html.match(/<article /g)).toHaveLength(1);
    expect(html).toContain("Third turn after the reply.");
    expect(html).not.toContain("earlier-attempt");
    expect(html).not.toContain("Earlier attempt");
    expect(html).not.toContain("Earlier session turn.");
    const provider = createLiveStatusProvider(db, { env: {} });
    expect(await provider.alias("sessions", "earlier-session")).toBe("PAS-367");
    expect(await provider.alias("runs", old.id)).toBe("PAS-367");
  });

  test("sibling sub-issues that share one Linear session keep one page each, naming the session", async () => {
    const db = database();
    await threeRuns(db);
    insertQueuedItem(db, { id: "sibling", title: "Sibling", sessionKey: SESSION, now: T0 + 10 });
    identify(db, "sibling", "PAS-368", "lin-368");
    const snapshot = await snapshotOf(db);
    const own = issuePage(snapshot);
    const sibling = issuePage(snapshot, "PAS-368");
    expect(own).toContain('<dt>Session</dt><dd><a href="https://linear.app/issue/PAS-367"');
    expect(own).toContain('shared with <a class="lin-id" href="/issues/PAS-368">PAS-368</a>');
    expect(sibling).toContain('shared with <a class="lin-id" href="/issues/PAS-367">PAS-367</a>');
    expect(sibling).not.toContain("First turn read the issue.");
    expect(await createLiveStatusProvider(db, { env: {} }).alias("sessions", SESSION)).toBe(
      "PAS-367",
    );
  });

  test("the page names the task only as PAS-367, with no internal id in visible text", async () => {
    const db = database();
    insertQueuedItem(db, {
      id: EARLIER,
      title: "Keep runs",
      sessionKey: "earlier-session",
      now: 0,
    });
    identify(db, EARLIER, "PAS-367");
    await beginImplementRun(sqliteDb(db), EARLIER, T0 - 7_200_000);
    db.run("UPDATE work_item SET state = 'cancelled' WHERE id = ?", [EARLIER]);
    await threeRuns(db);
    const snapshot = await snapshotOf(db);
    const text = visibleText(issuePage(snapshot));
    expect(text).toContain("PAS-367");
    expect(text).toContain("Task: PAS-367");
    expect(text).not.toMatch(ULID);
    expect(text).not.toMatch(UUID);
  });

  test("the item timeline reads work_item_event, a restart with its reason", async () => {
    const db = database();
    await threeRuns(db);
    applyWorkItemEvent(db, ITEM, "restart", {
      kind: "restart",
      reason: "follow_up",
      actor: "Jonas Berg",
      now: T0 + 200_000,
    });
    const item = (await snapshotOf(db)).items.find((entry) => entry.id === "PAS-367");
    expect(item?.timeline?.map((entry) => [entry.from, entry.event, entry.to, entry.kind])).toEqual(
      [
        ["queued", "dispatched", "running", "transition"],
        ["running", "restart", "queued", "restart"],
      ],
    );
    expect(item?.timeline?.[1]).toMatchObject({
      at: new Date(T0 + 200_000).toISOString(),
      reason: "follow_up",
      actor: "Jonas Berg",
    });
    const html = render({
      route: { view: "issues", id: "PAS-367" },
      phase: "ready",
      issue: (await snapshotOf(db)).details.get("PAS-367") ?? null,
      error: null,
      engineUrl: null,
      closeout: openedView({ "section\ndetails:PAS-367": true }),
    }).content;
    expect(html).toContain("Back to the agent for a follow-up in Linear.");
    expect(html).toContain("by Jonas Berg");
  });

  test("dead outbox rows and dead jobs of the issue are listed with a retry", async () => {
    const db = database();
    await threeRuns(db);
    insertQueuedItem(db, { id: "other", title: "Other", sessionKey: "other-session", now: T0 });
    identify(db, "other", "PAS-368", "lin-368");
    const elicitation = await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "elicitation",
      orderingKey: SESSION,
      idempotencyKey: "question:q1",
      payload: { sessionId: SESSION, body: "Which repository?" },
      now: T0 + 130_000,
    });
    const job = await enqueueJob(sqliteDb(db), {
      queue: "run.resume",
      payload: { itemId: ITEM },
      now: T0 + 140_000,
    });
    const otherJob = await enqueueJob(sqliteDb(db), {
      queue: "run.resume",
      payload: { itemId: "other" },
      now: T0,
    });
    db.run(
      "UPDATE outbox SET status = 'dead', attempts = 5, error = 'Linear is down' WHERE id = ?",
      [elicitation],
    );
    db.run(
      "UPDATE job SET status = 'dead', attempts = 10, last_error = 'runner lost', finished_at = ? WHERE id IN (?, ?)",
      [T0 + 150_000, job, otherJob],
    );

    const snapshot = await snapshotOf(db);
    const expected: StatusDeadDelivery[] = [
      {
        itemId: "PAS-368",
        kind: "job",
        target: `job:${otherJob}`,
        name: "run.resume",
        attempts: 10,
        lastError: "runner lost",
        at: new Date(T0 + 150_000).toISOString(),
        retryable: true,
      },
      {
        itemId: "PAS-367",
        kind: "outbox",
        target: `outbox:${elicitation}`,
        name: "linear.elicitation",
        attempts: 5,
        lastError: "Linear is down",
        at: new Date(T0 + 130_000).toISOString(),
        retryable: true,
      },
      {
        itemId: "PAS-367",
        kind: "job",
        target: `job:${job}`,
        name: "run.resume",
        attempts: 10,
        lastError: "runner lost",
        at: new Date(T0 + 150_000).toISOString(),
        retryable: true,
      },
    ];
    const order = (left: StatusDeadDelivery, right: StatusDeadDelivery) =>
      left.at.localeCompare(right.at) || left.target.localeCompare(right.target);
    expect(snapshot.dead.sort(order)).toEqual(expected.sort(order));

    const html = issuePage(snapshot);
    expect(html).toContain('id="dead-deliveries"');
    expect(html).toContain(`data-retry="outbox:${elicitation}"`);
    expect(html).toContain(`data-retry="job:${job}"`);
    expect(html).not.toContain(`data-retry="job:${otherJob}"`);
    const text = visibleText(html);
    expect(text).toContain("Linear question");
    expect(text).toContain("Last error: Linear is down");
    expect(text).toContain("Job run.resume");
    expect(text).not.toMatch(ULID);
    expect(issuePage(snapshot, "PAS-368")).toContain(`data-retry="job:${otherJob}"`);
    expect(text).not.toContain("Paws will not retry it");

    // After the item moves on, its dead job is still listed, but without a retry.
    db.run("UPDATE work_item SET version = version + 1 WHERE id = ?", [ITEM]);
    const moved = await snapshotOf(db);
    expect(moved.dead?.find((entry) => entry.target === `job:${job}`)?.retryable).toBe(false);
    const after = issuePage(moved);
    expect(after).toContain(`data-retry="outbox:${elicitation}"`);
    expect(after).not.toContain(`data-retry="job:${job}"`);
    expect(visibleText(after)).toContain(
      "From an earlier state of this issue. Paws will not retry it.",
    );
  });
});
