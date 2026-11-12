import { expect, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  type Db,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import * as scheduler from "../src/scheduler";
import type { SchedulerOptions } from "../src/scheduler";
import { seed } from "./dialects";
import { confirmFakeMergePg, workspaceDispatchPg } from "./fake-workspace";
import { tempStore } from "./pglite";

function setState(db: Db, id: string, state: string) {
  return seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));
}

function sameDelegation(db: Db, ids: readonly string[]) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ delegationId: "shared" })
      .where(inArray(q.t.workItem.id, [...ids])),
  );
}

test("dispatch asks readiness itself instead of trusting a handed-in ready list", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "blocker", now: 1 });
    await insertQueuedItem(db, { id: "blocked", now: 2 });
    await sameDelegation(db, ["blocker", "blocked"]);
    await seed(db, (q) =>
      q.orm.insert(q.t.taskBlock).values({
        blockerLinearIssueId: "lin-item-blocker",
        blockedLinearIssueId: "lin-item-blocked",
      }),
    );
    expect(await workspaceDispatchPg(db, { now: 1000 })).toEqual(["blocker"]);
    await confirmFakeMergePg(db, "blocker");
    await setState(db, "blocker", "merged");
    expect(await workspaceDispatchPg(db, { now: 1001 })).toEqual(["blocked"]);
  } finally {
    await close();
  }
});

test("dispatch admits ready Items while another one is in flight", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "first", now: 1 });
    expect(await workspaceDispatchPg(db, { now: 1000 })).toEqual(["first"]);
    await setState(db, "first", "running");
    const started = (await listJobs(db))
      .filter((job) => (job.payload as { itemId?: string }).itemId === "first")
      .map((job) => job.id);
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ status: "done" }).where(inArray(q.t.job.id, started)),
    );
    await insertQueuedItem(db, { id: "second", now: 2 });
    await insertQueuedItem(db, { id: "third", now: 3 });
    expect(await workspaceDispatchPg(db, { now: 1001 })).toEqual(["second", "third"]);
  } finally {
    await close();
  }
});

test("the orchestrator dispatches after the transition's transaction has resolved", async () => {
  const { db, close } = await tempStore();
  const root = await mkdtemp(join(tmpdir(), "paws-dispatch-"));
  let open = 0;
  const store = {
    ...db,
    transaction: async (body) => {
      open++;
      try {
        return await db.transaction(body);
      } finally {
        open--;
      }
    },
  } as Db;
  const seen: { open: number; state: string | undefined }[] = [];
  const spy = spyOn(scheduler, "dispatch").mockImplementation(async () => {
    seen.push({ open, state: (await getWorkItem(db, "item"))?.state });
    return [];
  });
  try {
    const clock = new FakeClock(1_000);
    const orchestrator = new Orchestrator({
      store,
      clock,
      jobs: new JobLoop(db, clock),
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: root,
    });
    await insertQueuedItem(db, { id: "item", now: 1 });
    await beginImplementRun(db, "item", clock.now());
    const item = (await getWorkItem(db, "item"))!;
    await orchestrator["fail"](item, "broken", "The run broke.");
    expect(seen).toEqual([{ open: 0, state: "failed" }]);
  } finally {
    spy.mockRestore();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch yields an idle merge session to a ready sibling", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "merging", now: 1, sessionKey: "session" });
    await insertQueuedItem(db, { id: "next", now: 2, sessionKey: "session" });
    await sameDelegation(db, ["merging", "next"]);
    await setState(db, "merging", "merge_queue");
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: "lin-item-merging",
      now: 1,
    });
    await seed(db, (q) =>
      q.orm
        .update(q.t.linearSession)
        .set({ activeItemId: "merging" })
        .where(eq(q.t.linearSession.sessionId, "session")),
    );
    await workspaceDispatchPg(db, { now: 1000 });
    expect(
      (
        await db.run((q) =>
          q.one(
            q.orm
              .select({ active: q.t.linearSession.activeItemId })
              .from(q.t.linearSession)
              .where(eq(q.t.linearSession.sessionId, "session")),
          ),
        )
      )?.active,
    ).toBeNull();
  } finally {
    await close();
  }
});

test("dispatch reports the ready items it left waiting", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "first", now: 1 });
    await insertQueuedItem(db, { id: "second", now: 2 });
    const waiting: string[] = [];
    const options: SchedulerOptions & { onWaiting: (ids: readonly string[]) => void } = {
      now: 1000,
      ownerCap: 1,
      onWaiting: (ids) => waiting.push(...ids),
    };
    expect(await workspaceDispatchPg(db, options)).toEqual(["first"]);
    expect(waiting).toEqual(["second"]);
  } finally {
    await close();
  }
});
