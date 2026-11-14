import { expect, test } from "bun:test";
import type { Db, Q } from "../src/db";
import { pruneLoopQueues } from "../src/runner-work";
import { forEachDialect, json, seed, withoutForeignKeys } from "./dialects";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const ago = (days: number) => NOW - days * DAY;

const NOTHING = {
  job: 0,
  outbox: 0,
  inbox_event: 0,
  linear_access_event: 0,
  agent_model_probe: 0,
};

function keys<T>(db: Db, read: (q: Q) => PromiseLike<T[]>, key: (row: T) => string | number) {
  return db.run((q) => q.all(read(q))).then((rows) => rows.map(key).sort());
}

forEachDialect((open) => {
  test("the prune deletes finished one-off jobs a week after they finish", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const job = (
      id: number,
      status: string,
      finishedDaysAgo: number | null,
      recurringEveryMs: number | null = null,
    ) =>
      seed(db, (q) =>
        q.orm.insert(q.t.job).values({
          id,
          queue: `queue-${id}`,
          jobKey: `key-${id}`,
          payload: json(db, {}),
          runAt: 0,
          status,
          createdAt: 0,
          finishedAt: finishedDaysAgo === null ? null : ago(finishedDaysAgo),
          recurringEveryMs,
        }),
      );
    await job(1, "done", 8);
    await job(2, "cancelled", 30);
    await job(3, "done", 6);
    await job(4, "dead", 30);
    await job(5, "done", 30, 60_000);
    await job(6, "pending", null);
    await job(7, "done", 30);
    await job(8, "done", 30);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.schedulerAdmission).values({
          itemId: "item",
          jobId: 7,
          projectKey: "p",
          repositoryKey: "r",
          paths: json(db, []),
          hot: 0,
          createdAt: 0,
        }),
      (q) =>
        q.orm
          .insert(q.t.closeoutRetryWindow)
          .values({ jobId: 8, activationId: 0, itemId: "item", retryBaseline: json(db, {}) }),
    );
    const left = () =>
      keys(
        db,
        (q) => q.orm.select({ id: q.t.job.id }).from(q.t.job),
        (row) => row.id,
      );
    const before = await left();

    expect(await pruneLoopQueues({ store: db, now: NOW })).toEqual({ ...NOTHING, job: 2 });
    expect(await left()).toEqual(before.filter((id) => id !== 1 && id !== 2));
    expect(await pruneLoopQueues({ store: db, now: NOW })).toEqual(NOTHING);
    await close();
  });

  test("the prune deletes sent outbox rows after a week and keeps the rows later deliveries read", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    let id = 0;
    const row = (
      key: string,
      options: {
        status?: string;
        sentDaysAgo?: number;
        orderingKey?: string | null;
        op?: string;
        deliveryKind?: string;
      } = {},
    ) =>
      seed(db, (q) =>
        q.orm.insert(q.t.outbox).values({
          id: ++id,
          target: "linear",
          op: options.op ?? "activity",
          orderingKey: options.orderingKey === undefined ? "session" : options.orderingKey,
          idempotencyKey: key,
          payload: json(db, {}),
          status: options.status ?? "sent",
          createdAt: 0,
          sentAt:
            options.status === "sent" || options.status === undefined
              ? ago(options.sentDaysAgo ?? 8)
              : null,
          deliveryKind: options.deliveryKind ?? "progress",
        }),
      );
    await row("old-thought");
    await row("recent-thought", { sentDaysAgo: 6 });
    await row("dead", { status: "dead" });
    await row("pending", { status: "pending" });
    await row("no-session", { orderingKey: null, op: "github.comment" });
    await row("pull-request-ready:item", { deliveryKind: "ordered" });
    await row("merged:item", { deliveryKind: "ordered" });
    await row("stop", { deliveryKind: "stop", op: "stop" });
    await row("terminal", { deliveryKind: "terminal", op: "terminal" });
    await row("parent-summary:d");
    await row("link-ask-reminder:q");
    await row("plan-old", { op: "linear.session.plan", deliveryKind: "status" });
    await row("plan-new", { op: "linear.session.plan", deliveryKind: "status" });
    await row("other-session-plan", {
      op: "linear.session.plan",
      deliveryKind: "status",
      orderingKey: "other",
    });
    await row("newest-activity");

    expect(await pruneLoopQueues({ store: db, now: NOW })).toEqual({ ...NOTHING, outbox: 3 });
    expect(
      await keys(
        db,
        (q) => q.orm.select({ key: q.t.outbox.idempotencyKey }).from(q.t.outbox),
        (left) => left.key,
      ),
    ).toEqual(
      [
        "recent-thought",
        "dead",
        "pending",
        "pull-request-ready:item",
        "merged:item",
        "stop",
        "terminal",
        "parent-summary:d",
        "link-ask-reminder:q",
        "plan-new",
        "other-session-plan",
        "newest-activity",
      ].sort(),
    );
    await close();
  });

  test("the prune deletes handled inbox events after two weeks and keeps each issue's newest state", async () => {
    const { db, close } = await open();
    const event = (
      key: string,
      options: {
        action?: string;
        handled?: number;
        receivedDaysAgo?: number;
        issue?: string;
        updatedAtMs?: number;
      } = {},
    ) =>
      seed(db, (q) =>
        q.orm.insert(q.t.inboxEvent).values({
          dedupeKey: key,
          deliveryId: `delivery-${key}`,
          source: "webhook",
          action: options.action ?? "other",
          updatedAtMs: options.updatedAtMs ?? 0,
          payload: json(
            db,
            options.issue === undefined
              ? { type: "Comment" }
              : { type: "Issue", organizationId: "org", data: { id: options.issue } },
          ),
          receivedAt: ago(options.receivedDaysAgo ?? 15),
          handled: options.handled ?? 1,
        }),
      );
    await event("old-comment");
    await event("recent-comment", { receivedDaysAgo: 13 });
    await event("unhandled", { handled: 0 });
    await event("created", { action: "created" });
    await event("prompted", { action: "prompted" });
    await event("issue-a-1", { issue: "a", updatedAtMs: 1 });
    await event("issue-a-2", { issue: "a", updatedAtMs: 2 });
    await event("issue-b", { issue: "b", updatedAtMs: 1 });

    expect(await pruneLoopQueues({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      inbox_event: 2,
    });
    expect(
      await keys(
        db,
        (q) => q.orm.select({ key: q.t.inboxEvent.dedupeKey }).from(q.t.inboxEvent),
        (left) => left.key,
      ),
    ).toEqual(["created", "issue-a-2", "issue-b", "prompted", "recent-comment", "unhandled"]);
    await close();
  });

  test("the prune deletes Linear access events after 30 days and finished model probes after a week", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.linearAccessEvent).values([
          { eventKey: "old", createdAt: ago(31) },
          { eventKey: "recent", createdAt: ago(29) },
        ]),
      (q) =>
        q.orm.insert(q.t.agentModelProbe).values(
          [
            ["old", ago(8)],
            ["recent", ago(6)],
            ["pending", null],
          ].map(([commandId, finishedAt]) => ({
            commandId: commandId as string,
            runnerId: "runner",
            userId: "user",
            agent: "codex",
            model: "m",
            requestedAt: 0,
            finishedAt: finishedAt as number | null,
          })),
        ),
    );

    expect(await pruneLoopQueues({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      linear_access_event: 1,
      agent_model_probe: 1,
    });
    expect(
      await keys(
        db,
        (q) => q.orm.select({ key: q.t.linearAccessEvent.eventKey }).from(q.t.linearAccessEvent),
        (row) => row.key,
      ),
    ).toEqual(["recent"]);
    expect(
      await keys(
        db,
        (q) => q.orm.select({ key: q.t.agentModelProbe.commandId }).from(q.t.agentModelProbe),
        (row) => row.key,
      ),
    ).toEqual(["pending", "recent"]);
    await close();
  });
});
