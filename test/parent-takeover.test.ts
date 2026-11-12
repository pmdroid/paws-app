import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ensureLinearSession, recordLinearInstallation } from "../src/db";
import type { AcceptedLinearEvent, EpicSnapshot } from "../src/linear";
import { json, seed } from "./dialects";
import { createParentFixturePg } from "./local/parent-fixture";

type Fixture = Awaited<ReturnType<typeof createParentFixturePg>>;

async function delegate(f: Fixture, blocked = false) {
  const parent: EpicSnapshot = {
    linearIssueId: "parent",
    identifier: "PAR-1",
    title: "Parent",
    description: "Parent body",
    teamId: "team",
    subIssues: [{ linearIssueId: "a", identifier: "CH-1", title: "First", teamId: "team" }],
  };
  f.tracker.epics.set("parent", parent);
  f.tracker.epics.set("a", { ...parent.subIssues[0]!, description: "Do it", subIssues: [] });
  if (blocked) {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    // Linear reports the outside blocker as still in progress.
    const at = f.clock.now();
    await seed(f.db, (q) =>
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey: `issue:outside:${at}`,
        source: "webhook",
        action: "other",
        updatedAtMs: at,
        payload: json(f.db, {
          type: "Issue",
          action: "update",
          organizationId: "org",
          data: { id: "outside", identifier: "OUT-1", state: { type: "started" } },
        }) as string,
        receivedAt: at,
        handled: 1,
      }),
    );
  }
  await ensureLinearSession(f.db, {
    sessionId: "parent-session",
    issueId: "parent",
    organizationId: "org",
    creatorId: "lead",
    now: f.clock.now(),
  });
  const admitted = await f.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
  expect(admitted.ok).toBe(true);
  await f.parents.register(f.jobs);
  await f.jobs.tick();
}

function issueA(f: Fixture) {
  return f.db.run((q) =>
    q.one(
      q.orm
        .select({
          sessionId: q.t.parentDelegationIssue.sessionId,
          delegationId: q.t.parentDelegationIssue.delegationId,
        })
        .from(q.t.parentDelegationIssue)
        .where(eq(q.t.parentDelegationIssue.issueId, "a")),
    ),
  );
}

/** Someone delegates the sub-issue again in Linear, which opens another session on it. */
async function created(f: Fixture, sessionId: string): Promise<AcceptedLinearEvent> {
  const known = await f.db.run((q) =>
    q.one(
      q.orm
        .select({ id: q.t.linearSession.sessionId })
        .from(q.t.linearSession)
        .where(eq(q.t.linearSession.sessionId, sessionId)),
    ),
  );
  if (!known) {
    await ensureLinearSession(f.db, { sessionId, issueId: "a", creatorId: "actor" });
    await recordLinearInstallation(f.db, {
      sessionId,
      organizationId: "org",
      teamId: "team",
      oauthClientId: "client",
      appUserId: "app",
      observedAtMs: f.clock.now(),
    });
  }
  return {
    action: "created",
    sessionId,
    issueId: "a",
    dedupeKey: sessionId,
    deliveryId: null,
    source: "webhook",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: f.clock.now(),
    payload: "{}",
  };
}

test("a second session on a running sub-issue is refused and the first keeps it", async () => {
  const f = await createParentFixturePg();
  try {
    await delegate(f);
    expect(f.started).toEqual(["a"]);
    const decision = await f.parents.authorizeEvent(await created(f, "again"));
    expect(decision).toEqual({
      outcome: "refused",
      reason:
        "CH-1 is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.",
    });
    expect(await f.parents.recheckEvent(await created(f, "again"))).toBe(false);
    expect(await f.parents.recheckEvent(await created(f, "session-a"))).toBe(true);
    expect((await issueA(f))?.sessionId).toBe("session-a");
  } finally {
    await f.close();
  }
});

test("a failed sub-issue starts again in a new session", async () => {
  const f = await createParentFixturePg();
  try {
    await delegate(f);
    await seed(f.db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ state: "failed" })
        .where(eq(q.t.workItem.linearIssueId, "a")),
    );
    expect(await f.parents.authorizeEvent(await created(f, "again"))).toEqual({
      outcome: "accepted",
    });
    expect(await issueA(f)).toEqual({ sessionId: "again", delegationId: null });
    const [item] = await f.db.run((q) =>
      q.all(
        q.orm
          .select({ state: q.t.workItem.state })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.linearIssueId, "a")),
      ),
    );
    expect(item).toEqual({ state: "cancelled" });
    expect(await f.db.run((q) => f.parents.actorSteps(q, "again"))).toBe("lead");
  } finally {
    await f.close();
  }
});

test("a sub-issue still waiting for its blockers refuses a session of its own", async () => {
  const f = await createParentFixturePg();
  try {
    await delegate(f, true);
    expect(f.started).toEqual([]);
    expect(await f.parents.authorizeEvent(await created(f, "early"))).toEqual({
      outcome: "refused",
      reason:
        "CH-1 waits for its blockers under its delegated parent. Paws opens its session when they finish.",
    });
  } finally {
    await f.close();
  }
});
