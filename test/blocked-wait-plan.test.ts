import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  insertQueuedItem,
  listOutbox,
} from "../src/db";
import { createFakeTracker, type SessionUpdate } from "../src/linear";
import { Orchestrator } from "../src/loop";
import type { ItemWait } from "../src/scheduler";
import { seed } from "./dialects";
import { workspaceAdmission } from "./fake-workspace";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

test("a blocked item's plan keeps one wait step whatever order its blockers come in", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker: createFakeTracker(),
    scheduling: async () => ({}),
  });
  const noteWaits = (waits: ItemWait[]) =>
    (orchestrator as unknown as { noteWaits(waits: ItemWait[]): Promise<void> }).noteWaits(waits);
  try {
    const item = await insertQueuedItem(db, { id: "blocked", now: 1_000, sessionKey: "session" });
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ linearIdentifier: "PAS-1" })
        .where(eq(q.t.workItem.id, "blocked")),
    );
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(db, "session", item.delegationId);
    const wait = (blockers: string[]): ItemWait => ({
      itemId: "blocked",
      sessionId: "session",
      identifier: "PAS-1",
      version: item.version,
      kind: "blocked",
      blockers,
    });
    const plans = async () =>
      (await listOutbox(db, "session")).filter((row) => row.op === "linear.session.plan");
    const plan = async () => ((await plans()).at(-1)!.payload as SessionUpdate).plan ?? [];
    const waitSteps = async () => (await plan()).filter((step) => step.content.startsWith("Wait"));

    await noteWaits([wait(["PAS-12", "PAS-3"])]);
    await noteWaits([wait(["PAS-3", "PAS-12"])]);
    expect(await plans()).toHaveLength(1);
    expect(await waitSteps()).toEqual([
      { content: "Wait for PAS-3, PAS-12", status: "inProgress" },
    ]);

    const length = (await plan()).length;
    await noteWaits([wait(["PAS-12", "PAS-4", "PAS-3"])]);
    expect(await plan()).toHaveLength(length);
    expect(await waitSteps()).toEqual([
      { content: "Wait for PAS-3, PAS-4, PAS-12", status: "inProgress" },
    ]);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});
