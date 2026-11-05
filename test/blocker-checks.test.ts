import { expect, test } from "bun:test";
import {
  bindLinearSessionTask,
  blockerCheckedAt,
  listTaskBlockers,
  listWorkItems,
  migrate,
  openDatabase,
  recordLinearInstallation,
  saveItemHolds,
} from "../src/db";
import {
  BLOCKED_RELATIONS_POLL_MS,
  createBlockerCheckRoute,
  createItemReconciler,
  createRelationsPolls,
  intakeDelegatedIssue,
  RELATIONS_POLL_MS,
  relationsPollIntervalMs,
} from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";

const BLOCKED_BY_B = [{ blockerLinearIssueId: "acme-b", blockedLinearIssueId: "acme-child" }];

async function blockedFixture(options: { blocked?: boolean; lowBudget?: boolean } = {}) {
  let clock = 10_000;
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "acme-parent",
      identifier: "ACME-1",
      title: "Export rows",
      description: null,
      subIssues: [{ linearIssueId: "acme-child", identifier: "ACME-2", title: "Write rows" }],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "acme-parent",
    teamId: "acme-team",
    stateType: "started",
    assigneeId: null,
    delegateId: "acme-app",
  });
  lifecycle.issues.set("acme-child", { ...lifecycle.issue, id: "acme-child" });
  lifecycle.issues.set("acme-b", { ...lifecycle.issue, id: "acme-b" });
  const intake = await intakeDelegatedIssue(db, tracker, {
    linearIssueId: "acme-parent",
    now: 1000,
  });
  if (!intake.ok) throw new Error("intake failed");
  db.run("INSERT INTO workspace VALUES('acme-workspace','acme-org','Acme',1000)");
  recordLinearInstallation(db, {
    organizationId: "acme-org",
    oauthClientId: "acme-client",
    appUserId: "acme-app",
    sessionId: "acme-session",
    teamId: "acme-team",
    observedAtMs: 1000,
  });
  bindLinearSessionTask(db, "acme-session", intake.delegation.id, { actorId: "acme-human" });
  if (options.blocked !== false) tracker.deps.set("acme-child", BLOCKED_BY_B);
  let epicReads = 0;
  const reconciler = createItemReconciler({
    db,
    tracker: {
      ...tracker,
      async loadEpic(id) {
        epicReads++;
        return tracker.loadEpic(id);
      },
    },
    lifecycle,
    onChanges() {},
    now: () => clock,
  });
  await reconciler.sweep({ now: clock });
  const child = listWorkItems(db).find((item) => item.linearIssueId === "acme-child")!;
  if (options.blocked !== false)
    saveItemHolds(db, [{ itemId: child.id, reason: "blocked", blockers: ["ACME-12"] }]);
  tracker.blockerReads.length = 0;
  let executionReconciles = 0;
  const polls = createRelationsPolls({
    db,
    reconciler,
    lowBudget: () => options.lowBudget ?? false,
    reconcileExecution: () => executionReconciles++,
    now: () => clock,
  });
  return {
    db,
    tracker,
    reconciler,
    polls,
    child,
    epicReads: () => epicReads,
    executionReconciles: () => executionReconciles,
    advance(ms: number) {
      clock += ms;
    },
    async [Symbol.asyncDispose]() {
      await reconciler.close();
      db.close();
    },
  };
}

test("the fast relations poll unblocks an item whose blocker was removed in Linear", async () => {
  await using fixture = await blockedFixture();
  expect(listTaskBlockers(fixture.db, "acme-child")).toEqual(["acme-b"]);
  expect(fixture.polls.intervalMs()).toBe(BLOCKED_RELATIONS_POLL_MS);
  fixture.tracker.deps.set("acme-child", []);
  fixture.advance(BLOCKED_RELATIONS_POLL_MS);
  expect(await fixture.polls.blocked()).toHaveLength(1);
  expect(listTaskBlockers(fixture.db, "acme-child")).toEqual([]);
  expect(fixture.executionReconciles()).toBe(1);
  expect(fixture.tracker.blockerReads).toEqual([["acme-child"]]);
  expect(blockerCheckedAt(fixture.db, fixture.child.id)).toBe(10_000 + BLOCKED_RELATIONS_POLL_MS);
});

test("with nothing blocked the relations poll keeps five minutes and reads nothing fast", async () => {
  await using fixture = await blockedFixture({ blocked: false });
  expect(relationsPollIntervalMs({ blocked: false, lowBudget: false })).toBe(RELATIONS_POLL_MS);
  expect(fixture.polls.intervalMs()).toBe(RELATIONS_POLL_MS);
  expect(await fixture.polls.blocked()).toEqual([]);
  expect(fixture.tracker.blockerReads).toEqual([]);
  expect(fixture.executionReconciles()).toBe(0);
});

test("a low Linear budget keeps the relations poll at five minutes with blocked items", async () => {
  await using fixture = await blockedFixture({ lowBudget: true });
  expect(relationsPollIntervalMs({ blocked: true, lowBudget: true })).toBe(RELATIONS_POLL_MS);
  expect(fixture.polls.intervalMs()).toBe(RELATIONS_POLL_MS);
  fixture.tracker.deps.set("acme-child", []);
  expect(await fixture.polls.blocked()).toEqual([]);
  expect(fixture.tracker.blockerReads).toEqual([]);
  expect(await fixture.polls.all()).toHaveLength(1);
  expect(fixture.tracker.blockerReads).toEqual([["acme-child"]]);
});

test("Check blockers now reads the item at once and refuses a second press within 15 s", async () => {
  await using fixture = await blockedFixture();
  const route = createBlockerCheckRoute({
    db: fixture.db,
    polls: fixture.polls,
    blockedItemIds: fixture.reconciler.blockedItemIds,
  });
  const press = async (itemId: string, sessionIds = ["acme-session"]) => {
    const response = await route(
      new Request("http://127.0.0.1/api/blocker-checks", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "30" },
        body: JSON.stringify({ itemId }),
      }),
      sessionIds,
    );
    if (!response) throw new Error("the route did not answer");
    return response;
  };
  expect((await press("ACME-2", ["acme-other"])).status).toBe(409);
  const first = await press("ACME-2");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ itemId: fixture.child.id, changed: false });
  fixture.advance(10_000);
  const second = await press(fixture.child.id);
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe("5");
  expect(((await second.json()) as { error: string }).error).toBe(
    "Blockers for ACME-2 were just checked. Try again in 5 s.",
  );
  expect(fixture.tracker.blockerReads).toEqual([["acme-child"]]);
  fixture.advance(5_000);
  expect((await press("ACME-2")).status).toBe(200);
});

test("Check blockers now reports a failed Linear read instead of an unchanged check", async () => {
  await using fixture = await blockedFixture();
  const route = createBlockerCheckRoute({
    db: fixture.db,
    polls: fixture.polls,
    blockedItemIds: fixture.reconciler.blockedItemIds,
  });
  fixture.tracker.blockerFailures.push(new Error("Linear is unavailable"));
  const response = await route(
    new Request("http://127.0.0.1/api/blocker-checks", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "20" },
      body: JSON.stringify({ itemId: "ACME-2" }),
    }),
    ["acme-session"],
  );
  if (!response) throw new Error("the route did not answer");
  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: string }).error).toBe(
    "Linear did not return this item's blockers. Try again in a moment.",
  );
  expect(fixture.executionReconciles()).toBe(0);
});

test("an Issue webhook for a blocker still refreshes the items it blocks", async () => {
  await using fixture = await blockedFixture();
  const reads = fixture.epicReads();
  const targets = await fixture.reconciler.issueChanged({
    issueId: "acme-b",
    organizationId: "acme-org",
  });
  expect(targets.map((target) => target.itemId)).toContain(fixture.child.id);
  expect(fixture.epicReads()).toBe(reads + 1);
});
