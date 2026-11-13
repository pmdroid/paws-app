import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import {
  CLEANUP_BLOCKED_NOTICE,
  acceptLinearStop,
  blockConversation,
  enqueueJob,
  enqueueOutbox,
  getConversation,
  getJob,
  getLinearSession,
  getOutboxSteps,
  getWorkItem,
  submitCommand,
  type Db,
  type Q,
} from "../src/db";
import { jsonValue, seed } from "./dialects";
import {
  createExecutionControlsFixturePg,
  probeExecutionControls,
} from "./local/execution-controls";

function deadJob(db: Db, id: number, itemVersion?: number | null): Promise<void> {
  return seed(db, (q) =>
    q.orm
      .update(q.t.job)
      .set({
        status: "dead",
        ...(itemVersion === undefined
          ? {}
          : { itemVersion, payload: jsonValue(q, { itemId: "controlled" }) }),
      })
      .where(eq(q.t.job.id, id)),
  );
}

function audit(db: Db, where: (q: Q) => SQL | undefined) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          userId: q.t.workspaceAccessAudit.userId,
          action: q.t.workspaceAccessAudit.action,
          subject: q.t.workspaceAccessAudit.subject,
        })
        .from(q.t.workspaceAccessAudit)
        .where(where(q))
        .orderBy(asc(q.t.workspaceAccessAudit.id)),
    ),
  );
}

test("Workspace execution controls reach canonical Stop, Pause and Resume with current authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-"));
  try {
    const observations = await probeExecutionControls(root);
    assert.equal(observations.length, 10);
    assert(observations.every((entry) => entry.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Retry puts a dead job of an authorized item back to pending and refuses everything else", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-retry-"));
  const fixture = await createExecutionControlsFixturePg(root);
  try {
    const { db, origin } = fixture;
    const retry = (target: unknown, identity = "member") =>
      fetch(`${origin}/api/execution-controls`, {
        method: "POST",
        headers: fixture.headers(identity),
        body: JSON.stringify({ action: "retry", target }),
      });
    const dead = async (itemId: string) =>
      await enqueueJob(db, {
        queue: "test.unhandled",
        payload: { itemId },
        jobKey: `dead:${itemId}`,
        runAt: Date.now() + 3_600_000,
      });
    const mine = await dead("controlled");
    const foreign = await dead("foreign");
    await seed(db, (q) =>
      q.orm
        .update(q.t.job)
        .set({ status: "dead", lastError: "runner lost" })
        .where(inArray(q.t.job.id, [mine, foreign])),
    );

    assert.equal((await retry("job:x")).status, 400);
    assert.equal((await retry(`job:${mine}`, "inactive")).status, 401);
    assert.equal((await retry(`job:${foreign}`, "admin")).status, 403);
    assert.equal((await getJob(db, foreign))!.status, "dead");
    assert.equal((await retry(`job:${mine}`)).status, 200);
    assert.equal((await getJob(db, mine))!.status, "pending");
    assert.equal((await getJob(db, mine))!.attempts, 0);
    assert.equal((await retry(`job:${mine}`)).status, 403);

    // A dead job from an earlier state of the item is refused, so its work is not revived.
    const stale = await dead("controlled-stale");
    await deadJob(db, stale, -1);
    assert.equal((await retry(`job:${stale}`)).status, 409);
    assert.equal((await getJob(db, stale))!.status, "dead");

    // Once the session is stopped, only its dead final Stop delivery can be retried.
    const session = (await getWorkItem(db, "controlled"))!.sessionKey!;
    const stop = await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      delivery: "stop",
      idempotencyKey: "stop:controlled:retry-test",
      payload: { itemId: "controlled", kind: "response", body: "Stopped." },
    });
    const late = await dead("controlled-late");
    await deadJob(db, late, null);
    await seed(
      db,
      (q) =>
        q.orm
          .update(q.t.outbox)
          .set({ status: "dead", error: "Linear is down" })
          .where(eq(q.t.outbox.id, stop)),
      (q) =>
        q.orm
          .update(q.t.linearSession)
          .set({ stoppedAt: Date.now() })
          .where(eq(q.t.linearSession.sessionId, session)),
    );
    assert.equal((await retry(`job:${late}`)).status, 403);
    assert.equal((await getJob(db, late))!.status, "dead");
    assert.equal((await retry(`outbox:${stop}`, "inactive")).status, 401);
    assert.equal((await retry(`outbox:${stop}`)).status, 200);
    assert.equal((await db.run((q) => getOutboxSteps(q, stop)))!.status, "pending");
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Clear stuck agent clears a blocked conversation for an admin, refuses a member and is audited", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-stuck-"));
  const fixture = await createExecutionControlsFixturePg(root);
  try {
    const { db, call } = fixture;
    await blockConversation(db, "controlled", Date.now());
    const view = (await (await call(undefined, "admin")).json()) as {
      actions: string[];
      notice?: string;
    };
    assert(view.actions.includes("clear_stuck_agent"));
    assert.equal(view.notice, CLEANUP_BLOCKED_NOTICE);
    const member = (await (await call()).json()) as { actions: string[]; notice?: string };
    assert(!member.actions.includes("clear_stuck_agent"));
    assert.equal(member.notice, CLEANUP_BLOCKED_NOTICE);

    assert.equal((await call("clear_stuck_agent")).status, 403);
    assert.equal((await getConversation(db, "controlled")).blocked, true);
    assert.equal((await call("clear_stuck_agent", "admin")).status, 200);
    assert.equal((await getConversation(db, "controlled")).blocked, false);
    assert.deepEqual(
      await audit(db, (q) =>
        or(
          like(q.t.workspaceAccessAudit.action, "%clear_stuck_agent%"),
          like(q.t.workspaceAccessAudit.subject, "%clear_stuck_agent%"),
        ),
      ),
      [
        {
          userId: "member",
          action: "access.denied",
          subject: "execution.clear_stuck_agent:controlled",
        },
        { userId: "admin", action: "execution.clear_stuck_agent", subject: "controlled" },
      ],
    );
    // Nothing is blocked any more, so the action is gone.
    assert.equal((await call("clear_stuck_agent", "admin")).status, 409);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Resume restarts an item a Linear stop paused, and Stop cancels it", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-linear-stop-"));
  const fixture = await createExecutionControlsFixturePg(root);
  try {
    const { db, orchestrator, call } = fixture;
    const stop = async () => {
      await acceptLinearStop(db, "session-controlled", `stop:${Date.now()}`, Date.now());
      await submitCommand(db, orchestrator.bus, {
        type: "stop",
        source: "linear",
        itemId: "controlled",
        requestedAt: Date.now(),
      });
    };
    await stop();
    assert.equal((await getWorkItem(db, "controlled"))?.state, "paused");
    const view = (await (await call()).json()) as { actions: string[] };
    assert.deepEqual(view.actions, ["stop", "resume"]);
    assert.equal((await call("resume")).status, 200);
    assert.equal((await getWorkItem(db, "controlled"))?.state, "queued");
    assert.equal((await getLinearSession(db, "session-controlled"))?.stoppedAt, null);

    await stop();
    assert.equal((await call("stop")).status, 200);
    assert.equal((await getWorkItem(db, "controlled"))?.state, "cancelled");
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Asking which controls an item has is not a denial; a refused action still is", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-audit-"));
  const fixture = await createExecutionControlsFixturePg(root);
  try {
    const { db, call } = fixture;
    const denials = async () =>
      (await audit(db, (q) => eq(q.t.workspaceAccessAudit.action, "access.denied"))).map(
        ({ userId, subject }) => ({ userId, subject }),
      );
    // Not their session, another organization, and an item with no session at all.
    await seed(db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "sessionless",
        delegationId: "sessionless",
        linearIssueId: "sessionless",
        linearIdentifier: "sessionless",
        title: "No session",
        state: "queued",
        branchName: "paws/sessionless",
        position: 2,
        createdAt: Date.now(),
      }),
    );
    for (const [identity, itemId] of [
      ["outside", "controlled"],
      ["admin", "foreign"],
      ["admin", "sessionless"],
      ["admin", "missing"],
    ] as const) {
      const response = await call(undefined, identity, itemId);
      assert.equal(response.status, 200);
      assert.deepEqual(((await response.json()) as { actions: string[] }).actions, []);
    }
    assert.deepEqual(await denials(), []);

    for (const action of ["pause", "stop"])
      assert.equal((await call(action, "outside")).status, 403);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
    assert.deepEqual(await denials(), [
      { userId: "outside", subject: "execution-controls" },
      { userId: "outside", subject: "execution-controls" },
    ]);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
