import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";
import {
  applyWorkItemEvent,
  beginImplementRun,
  closeExpiredRunnerLeases,
  deferWorkItem,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  prepareShutdown,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
} from "./index";
import { json, seed, withoutForeignKeys } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const NOW = 1_000_000;

async function verifying(candidate = true) {
  const db = (await tempStore()).db;
  const item = await insertQueuedItem(db, { id: "item", sessionKey: "session", now: NOW });
  const { run } = await beginImplementRun(db, item.id, NOW);
  await applyWorkItemEvent(db, item.id, "turn_ended");
  if (candidate)
    await saveCheckpoint(db, item.id, {
      phase: "verifying",
      baseSha: "base",
      wipCommit: "head",
    });
  return { db, item: (await getWorkItem(db, item.id))!, run };
}

const pending = async (db: Awaited<ReturnType<typeof verifying>>["db"]) =>
  (await listJobs(db)).filter((job) => job.status === "pending");

describe("interrupted verification", () => {
  test("a clean shutdown keeps the candidate in verifying and the next start re-verifies it", async () => {
    const { db, item, run } = await verifying();
    await prepareShutdown(db, NOW + 1);
    expect((await getWorkItem(db, item.id))?.state).toBe("verifying");
    expect((await getRun(db, run.id))?.status).toBe("lost");
    expect(await recoverOnStartup(db, NOW + 2)).toEqual([{ type: "reverify", resumed: true }]);
    expect(await getWorkItem(db, item.id)).toMatchObject({
      state: "verifying",
      recoveryAttempts: 1,
    });
    expect((await pending(db)).map((job) => job.queue)).toEqual([JOB_KIND.reverify]);
  });

  test("a crash start re-verifies the candidate once and then asks", async () => {
    const { db, item } = await verifying();
    expect(await recoverOnStartup(db, NOW + 1)).toEqual([{ type: "reverify", resumed: true }]);
    expect(await recoverOnStartup(db, NOW + 2)).toEqual([{ type: "ask_restart" }]);
    expect((await listJobs(db)).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
    const held = (await getWorkItem(db, item.id))!;
    expect(held.state).toBe("recovering");
    expect(await restartHold(db, held)).not.toBeNull();
  });

  test("a start leaves a backed-off re-verify of a deferred candidate where it is", async () => {
    const { db, item } = await verifying();
    await deferWorkItem(db, item, {
      retry: 1,
      delayMs: 60_000,
      handoff: null,
      message: null,
      now: NOW,
    });
    await prepareShutdown(db, NOW + 1);
    expect(await recoverOnStartup(db, NOW + 2)).toEqual([]);
    expect(await pending(db)).toMatchObject([
      { queue: JOB_KIND.reverify, runAt: NOW + 60_000, payload: { retry: 1 } },
    ]);
    expect((await getWorkItem(db, item.id))?.recoveryAttempts).toBe(0);
  });

  test("a verifying item without a recorded candidate still moves to recovering", async () => {
    const { db, item } = await verifying(false);
    await prepareShutdown(db, NOW + 1);
    expect((await getWorkItem(db, item.id))?.state).toBe("recovering");
  });

  test("an expired runner lease keeps the candidate verifying, and re-verifies it without waiting for orphan recovery", async () => {
    const { db, item, run } = await verifying();
    await withoutForeignKeys(db);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: run.id,
          runnerId: "runner",
          workspaceId: "workspace",
          generation: 1,
          runnerFence: 0,
          commandId: "command",
          leaseUntil: NOW + 60_000,
        }),
      (q) =>
        q.orm.insert(q.t.job).values({
          queue: JOB_KIND.start,
          payload: json(db, { itemId: item.id }),
          status: "done",
          runAt: NOW,
          createdAt: NOW,
          finishedAt: NOW,
        }),
    );
    const later = NOW + 60_000 + RUNNER_LEASE_GRACE_MS + 10 * 60_000;
    expect(await closeExpiredRunnerLeases(db, later)).toEqual([run.id]);
    expect((await getWorkItem(db, item.id))?.state).toBe("verifying");
    expect((await getRun(db, run.id))?.status).toBe("lost");
    expect(await pending(db)).toMatchObject([
      { queue: JOB_KIND.reverify, payload: { itemId: item.id, recheckHead: true } },
    ]);
    expect(await requeueOrphanedWork(db, later)).toEqual([]);
  });

  test("Stop wins over a kept candidate", async () => {
    const { db, item } = await verifying();
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ cancelRequested: 1 }).where(eq(q.t.workItem.id, item.id)),
    );
    await prepareShutdown(db, NOW + 1);
    expect(await requeueOrphanedWork(db, NOW + 60 * 60_000)).toEqual([]);
  });
});
