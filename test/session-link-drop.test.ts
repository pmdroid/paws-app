import { workspaceDispatchPg } from "./fake-workspace";
import { expect, test } from "bun:test";
import {
  applyLinearCommand,
  beginImplementRun,
  bindLinearSessionTask,
  delegatedLinearUserId,
  ensureLinearSession,
  insertQueuedItem,
} from "../src/db";
import { handleStatusRequest } from "../src/dashboard";
import { tempStore } from "./pglite";

test("binding a session keeps an actor that has no workspace user", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, {
      id: "bound-item",
      sessionKey: "bound-session",
      now: 1,
    });
    await ensureLinearSession(db, {
      sessionId: "bound-session",
      creatorId: "linear-creator",
      now: 1,
    });
    await bindLinearSessionTask(db, "bound-session", item.delegationId, {
      actorId: "linear-actor",
    });
    expect(await delegatedLinearUserId(db, item.id)).toBe("linear-actor");
  } finally {
    await close();
  }
});

test("a stop command resolves the session through session_key alone", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, {
      id: "stop-item",
      sessionKey: "stop-session",
      now: 1,
    });
    expect(
      (
        await applyLinearCommand(db, {
          type: "stop",
          source: "linear",
          itemId: item.id,
          requestedAt: 5,
        })
      ).applied,
    ).toBe(true);
    const rows = await db.run((q) =>
      q.all(q.orm.select({ orderingKey: q.t.outbox.orderingKey }).from(q.t.outbox)),
    );
    expect(rows.map((row) => row.orderingKey)).toContain("stop-session");
  } finally {
    await close();
  }
});

test("a transcript lookup resolves the session through session_key alone", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, {
      id: "transcript-item",
      sessionKey: "transcript-session",
      now: 1,
    });
    const { run } = await beginImplementRun(db, item.id, 2);
    const response = await handleStatusRequest(
      new Request(`http://127.0.0.1/api/runs/transcript?run=${run.id}`, { method: "HEAD" }),
      { store: db, sessionIds: ["transcript-session"] },
    );
    expect(response?.status).toBe(200);
    const denied = await handleStatusRequest(
      new Request(`http://127.0.0.1/api/runs/transcript?run=${run.id}`, { method: "HEAD" }),
      { store: db, sessionIds: ["other-session"] },
    );
    expect(denied?.status).toBe(404);
  } finally {
    await close();
  }
});

test("the scheduler resolves a session item through session_key alone", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, {
      id: "sched-item",
      sessionKey: "sched-session",
      now: 1,
    });
    await ensureLinearSession(db, {
      sessionId: "sched-session",
      issueId: item.linearIssueId,
      now: 1,
    });
    expect(await workspaceDispatchPg(db, { now: 2 })).toEqual([item.id]);
    const rows = await db.run((q) =>
      q.all(
        q.orm.select({ sessionId: q.t.schedulerAdmission.sessionId }).from(q.t.schedulerAdmission),
      ),
    );
    expect(rows[0]?.sessionId).toBe("sched-session");
  } finally {
    await close();
  }
});
