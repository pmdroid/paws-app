import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { JOB_KIND, MAX_TRANSIENT_RETRIES, type Checkpoint } from "../core";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  closeExpiredRunnerLeases,
  completeJob,
  enqueueJob,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markRun,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
  setCurrentRun,
  type Db,
  type PgDb,
} from "./index";
import { seed, withoutForeignKeys } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const START = 1_000_000;
const LEASE_MS = 60_000;
const PAST = LEASE_MS + RUNNER_LEASE_GRACE_MS;
const ORPHAN_GRACE_MS = 5 * 60_000;
const running: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };
const candidate: Checkpoint = { phase: "verifying", wipCommit: "head", baseSha: "base" };

async function lease(db: Db, runId: string, generation: number, until: number) {
  await withoutForeignKeys(db);
  await seed(db, (q) =>
    q.orm
      .insert(q.t.runnerWork)
      .values({
        runId,
        runnerId: "runner",
        workspaceId: "workspace",
        generation,
        runnerFence: 0,
        commandId: "command",
        leaseUntil: until,
      })
      .onConflictDoUpdate({
        target: q.t.runnerWork.runId,
        set: { generation, leaseUntil: until, endedAt: null },
      }),
  );
}

async function leased() {
  const db = (await tempStore()).db;
  const item = await insertQueuedItem(db, { id: "item", sessionKey: "session", now: START });
  const { run } = await beginImplementRun(db, item.id, START, running);
  await lease(db, run.id, 1, START + LEASE_MS);
  return { db, item, run };
}

const pending = async (db: Db) => (await listJobs(db)).filter((job) => job.status === "pending");
const runnerWork = async (db: Db, runId: string) =>
  (
    await db.run((q) =>
      q.all(
        q.orm
          .select({ endedAt: q.t.runnerWork.endedAt })
          .from(q.t.runnerWork)
          .where(eq(q.t.runnerWork.runId, runId)),
      ),
    )
  )[0];

describe("follow-up after an expired runner lease", () => {
  test("running work resumes on the transient retry budget before the orphan grace", async () => {
    const { db, item, run } = await leased();
    const at = START + PAST;
    expect(await closeExpiredRunnerLeases(db, at)).toEqual([run.id]);
    const current = (await getWorkItem(db, item.id))!;
    expect(current.state).toBe("recovering");
    expect((await getRun(db, run.id))?.status).toBe("lost");
    expect((await runnerWork(db, run.id))?.endedAt).toBe(at);
    const [job] = await pending(db);
    expect(await pending(db)).toHaveLength(1);
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({ version: q.t.job.itemVersion })
            .from(q.t.job)
            .where(eq(q.t.job.id, job!.id)),
        ),
      ),
    ).toEqual([{ version: current.version }]);
    expect(job).toMatchObject({
      queue: JOB_KIND.resume,
      payload: { itemId: item.id, runId: run.id, reason: "transient_failure", retry: 1 },
    });
    expect(job!.runAt).toBeGreaterThan(at);
    expect(job!.runAt - at).toBeLessThan(ORPHAN_GRACE_MS);
    expect(await requeueOrphanedWork(db, at + ORPHAN_GRACE_MS + 1)).toEqual([]);
    expect(await closeExpiredRunnerLeases(db, at + 1)).toEqual([]);
    expect(await pending(db)).toHaveLength(1);
  });

  test("a verifying candidate re-verifies without an implementer turn", async () => {
    const { db, item, run } = await leased();
    await applyWorkItemEvent(db, item.id, "turn_ended");
    await saveCheckpoint(db, item.id, candidate);
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect((await getWorkItem(db, item.id))?.state).toBe("verifying");
    expect(await pending(db)).toMatchObject([
      {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id, recheckHead: true, failClosed: true, retry: 1 },
      },
    ]);
  });

  test("verifying work without a candidate resumes execution", async () => {
    const { db, item, run } = await leased();
    await applyWorkItemEvent(db, item.id, "turn_ended");
    await saveCheckpoint(db, item.id, null);
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect((await getWorkItem(db, item.id))?.state).toBe("recovering");
    expect((await pending(db)).map((job) => job.queue)).toEqual([JOB_KIND.resume]);
  });

  test("a merge-queue run re-verifies its head and leaves the merge phase", async () => {
    const { db, item, run } = await leased();
    await applyWorkItemEvent(db, item.id, "turn_ended");
    await applyWorkItemEvent(db, item.id, "closeout_accepted");
    await saveCheckpoint(db, item.id, { ...candidate, phase: "merge_queue" });
    await enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: item.id },
      now: START,
    });
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    const current = (await getWorkItem(db, item.id))!;
    expect(current.state).toBe("verifying");
    expect(current.checkpoint?.phase).toBe("verifying");
    expect((await pending(db)).filter((job) => job.queue === JOB_KIND.reverify)).toMatchObject([
      { payload: { itemId: item.id, recheckHead: true, failClosed: true } },
    ]);
    expect((await pending(db)).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
  });

  test("a valid pending job keeps ownership of the progress", async () => {
    const { db, item, run } = await leased();
    await applyWorkItemEvent(db, item.id, "turn_ended");
    await saveCheckpoint(db, item.id, candidate);
    await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      now: START,
    });
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect(await pending(db)).toHaveLength(1);
  });

  test("a live job owner keeps the run and gets no follow-up", async () => {
    const { db, item, run } = await leased();
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: item.id },
      now: START,
    });
    await claimNextJob(db, {
      now: START,
      leaseMs: PAST + 60_000,
      queues: [JOB_KIND.resume],
    });
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([]);
    expect((await getRun(db, run.id))?.status).toBe("active");
    expect(await pending(db)).toEqual([]);
  });

  test("a claimed job whose lock lapsed before the transition does not block the follow-up", async () => {
    const { db, item, run } = await leased();
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: item.id },
      now: START,
    });
    expect(
      await claimNextJob(db, { now: START, leaseMs: 1_000, queues: [JOB_KIND.resume] }),
    ).not.toBeNull();
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect(await pending(db)).toMatchObject([
      { queue: JOB_KIND.resume, payload: { reason: "transient_failure", retry: 1 } },
    ]);
  });

  test("a delivered result is left for import", async () => {
    const { db, item, run } = await leased();
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerResult).values({
        runId: run.id,
        generation: 1,
        commandId: "command",
        payload: {},
        receivedAt: START,
      }),
    );
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([]);
    expect((await getWorkItem(db, item.id))?.state).toBe("running");
    expect(await pending(db)).toEqual([]);
  });

  test("a stale run is closed without resuming the item", async () => {
    const { db, item, run } = await leased();
    await setCurrentRun(db, item.id, "newer-run");
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect((await getRun(db, run.id))?.status).toBe("lost");
    expect((await getWorkItem(db, item.id))?.state).toBe("running");
    expect(await pending(db)).toEqual([]);
  });

  test("a stopped item is not resumed", async () => {
    const { db, item, run } = await leased();
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ cancelRequested: 1 }).where(eq(q.t.workItem.id, item.id)),
    );
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect(await pending(db)).toEqual([]);
  });

  test("a paused item is not resumed", async () => {
    const { db, item, run } = await leased();
    await applyWorkItemEvent(db, item.id, "pause");
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect((await getWorkItem(db, item.id))?.state).toBe("paused");
    expect(await pending(db)).toEqual([]);
  });

  test("a pending restart decision is kept instead of resuming", async () => {
    const { db, item, run } = await leased();
    await seed(db, (q) =>
      q.orm
        .insert(q.t.restartHold)
        .values({ itemId: item.id, sessionId: "session", requestedAt: START }),
    );
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect((await pending(db)).map((job) => [job.queue, job.payload])).toEqual([
      ["item.ask", expect.objectContaining({ itemId: item.id, reason: "restart" })],
    ]);
  });

  test("repeated expiry spends the retry budget and then asks once", async () => {
    const { db, item, run } = await leased();
    let at = START + PAST;
    for (let generation = 1; generation <= MAX_TRANSIENT_RETRIES; generation++) {
      expect(await closeExpiredRunnerLeases(db, at)).toEqual([run.id]);
      const [job] = await pending(db);
      expect(job).toMatchObject({ queue: JOB_KIND.resume, payload: { retry: generation } });
      at = job!.runAt;
      const claimed = (await claimNextJob(db, {
        now: at,
        leaseMs: 1_000,
        queues: [JOB_KIND.resume],
      }))!;
      await applyWorkItemEvent(db, item.id, "recovered");
      await markRun(db, run.id, "active", at);
      await lease(db, run.id, generation + 1, at + LEASE_MS);
      await completeJob(db, claimed, at);
      at += PAST;
    }
    expect(await closeExpiredRunnerLeases(db, at)).toEqual([run.id]);
    const held = (await getWorkItem(db, item.id))!;
    expect(held.state).toBe("recovering");
    expect(await restartHold(db, held)).not.toBeNull();
    expect((await pending(db)).map((job) => job.queue)).toEqual(["item.ask"]);
    expect(await recoverOnStartup(db, at + 1)).toEqual([{ type: "ask_restart" }]);
    expect(await requeueOrphanedWork(db, at + ORPHAN_GRACE_MS + 1)).toEqual([]);
    expect((await pending(db)).map((job) => job.queue)).toEqual(["item.ask"]);
  });

  test("a start after expiry keeps the follow-up and spends no resume", async () => {
    const { db, item, run } = await leased();
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect(await recoverOnStartup(db, START + PAST + 1)).toEqual([]);
    expect((await getWorkItem(db, item.id))?.recoveryAttempts).toBe(0);
    expect((await pending(db)).map((job) => job.queue)).toEqual([JOB_KIND.resume]);
  });

  test("state, cleanup and the follow-up commit together", async () => {
    const { db, run } = await leased();
    const exec = (statement: string) => (db as PgDb).orm.execute(sql.raw(statement));
    await exec("SET session_replication_role = origin");
    await exec(
      "CREATE FUNCTION fail_follow_up() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'follow-up refused'; END $$ LANGUAGE plpgsql",
    );
    await exec(
      "CREATE TRIGGER fail_follow_up BEFORE INSERT ON job FOR EACH ROW EXECUTE FUNCTION fail_follow_up()",
    );
    await expect(closeExpiredRunnerLeases(db, START + PAST)).rejects.toMatchObject({
      cause: { message: "follow-up refused" },
    });
    expect((await getWorkItem(db, "item"))?.state).toBe("running");
    expect((await getRun(db, run.id))?.status).toBe("active");
    expect((await runnerWork(db, run.id))?.endedAt).toBeNull();
    await exec("DROP TRIGGER fail_follow_up ON job");
    expect(await closeExpiredRunnerLeases(db, START + PAST)).toEqual([run.id]);
    expect((await getWorkItem(db, "item"))?.state).toBe("recovering");
    expect((await getRun(db, run.id))?.status).toBe("lost");
    expect((await runnerWork(db, run.id))?.endedAt).toBe(START + PAST);
    expect(await pending(db)).toMatchObject([
      { queue: JOB_KIND.resume, payload: { reason: "transient_failure", retry: 1 } },
    ]);
  });
});
