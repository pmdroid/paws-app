import { expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { CommandBus, JOB_KIND } from "../src/core";
import { askSteps } from "../src/loop";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  beginMergeCall,
  completeMergedItem,
  drainCommands,
  endMergeCall,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  mergeCallInFlight,
  mergeStopRequested,
  recordConfirmedRemoteMerge,
  submitCommand,
} from "../src/db";
import { tempStore } from "./pglite";

async function setup() {
  const { db, close } = await tempStore();
  await insertQueuedItem(db, { id: "holder", sessionKey: "session", now: 1 });
  await applyWorkItemEvent(db, "holder", "dispatched", { now: 1 });
  await applyWorkItemEvent(db, "holder", "turn_ended", { now: 1 });
  await applyWorkItemEvent(db, "holder", "closeout_accepted", { now: 1 });
  return { db, close };
}
const command = {
  type: "stop" as const,
  source: "linear" as const,
  itemId: "holder",
  requestedAt: 10,
};

for (const exit of ["cancel", "ask", "fail"] as const) {
  test(`${exit} wakes parked followers immediately`, async () => {
    const { db, close } = await setup();
    for (const reason of ["ahead", "dependencies", "ci"])
      await enqueueJob(db, {
        queue: JOB_KIND.merge,
        jobKey: reason,
        payload: { itemId: reason, mergeWait: { reason } },
        now: 1,
        runAt: 300_000,
      });
    if (exit === "cancel") await applyLinearCommand(db, command, 10);
    if (exit === "ask")
      await db.transaction((q) =>
        askSteps(
          q,
          { itemId: "holder", runId: null, sessionId: "session" },
          "ci-help",
          "Need guidance",
          {
            now: 10,
          },
        ),
      );
    if (exit === "fail") {
      await applyWorkItemEvent(db, "holder", "lease_expired", { now: 10 });
      await applyWorkItemEvent(db, "holder", "closeout_infra_failed", { now: 10 });
    }
    expect(
      (await listJobs(db))
        .filter((j) => j.queue === JOB_KIND.merge)
        .map((j) => [j.jobKey, j.runAt]),
    ).toEqual([
      ["ahead", 10],
      ["dependencies", 10],
      ["ci", 300_000],
    ]);
    await close();
  });
}

test("a stop during a successful squash waits for completion and answers already merged once", async () => {
  const { db, close } = await setup();
  const bus = new CommandBus();
  const emitted: unknown[] = [];
  bus.subscribe((c) => emitted.push(c));
  await beginMergeCall(db, "holder", "head", 5);
  expect(await submitCommand(db, bus, command)).toEqual({ applied: false });
  expect(await getWorkItem(db, "holder")).toMatchObject({
    state: "merge_queue",
    cancelRequested: false,
  });
  expect(await mergeStopRequested(db, "holder")).toBe(true);
  expect(await drainCommands(db, bus, 1_010)).toBe(1);
  await recordConfirmedRemoteMerge(db, {
    itemId: "holder",
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: "merged",
    confirmedAt: 1_020,
  });
  expect((await completeMergedItem(db, { itemId: "holder", now: 1_020 }))?.state).toBe("merged");
  expect(await completeMergedItem(db, { itemId: "holder", now: 1_021 })).toBeNull();
  expect(await mergeCallInFlight(db, "holder")).toBe(false);
  await drainCommands(db, bus, 2_010);
  await drainCommands(db, bus, 3_010);
  expect(emitted).toEqual([]);
  expect((await getWorkItem(db, "holder"))?.state).toBe("merged");
  const bodies = (await listOutbox(db)).map((row) =>
    String((row.payload as { body?: string }).body),
  );
  expect(bodies.filter((b) => b.startsWith("Merged #1"))).toHaveLength(1);
  expect(bodies.filter((b) => b.includes("was already merged"))).toHaveLength(1);
  expect(bodies.some((b) => b.startsWith("Stopped"))).toBe(false);
  expect(
    await db.run((q) =>
      q.all(
        q.orm
          .select({ n: count() })
          .from(q.t.workItemEvent)
          .where(eq(q.t.workItemEvent.event, "merge_accepted")),
      ),
    ),
  ).toEqual([{ n: 1 }]);
  await close();
});

test("a deferred stop cancels when the squash did not succeed", async () => {
  const { db, close } = await setup();
  const bus = new CommandBus();
  await beginMergeCall(db, "holder", "head", 5);
  expect(
    (
      await applyLinearCommand(db, command, 10, "Stopped by test.", {
        keepPullRequest: true,
      })
    ).deferred,
  ).toBe(true);
  await endMergeCall(db, "holder");
  await drainCommands(db, bus, 1_010);
  expect((await getWorkItem(db, "holder"))?.state).toBe("cancelled");
  expect((await listJobs(db)).some((j) => j.queue === JOB_KIND.closeStoppedPull)).toBe(false);
  expect(
    (await listOutbox(db)).some((row) =>
      String((row.payload as { body?: string }).body).startsWith("Stopped by test."),
    ),
  ).toBe(true);
  await close();
});
