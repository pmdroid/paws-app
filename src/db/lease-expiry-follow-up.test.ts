import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  migrate,
  openDatabase,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
  setCurrentRun,
  sqliteDb,
} from "./index";

const START = 1_000_000;
const LEASE_MS = 60_000;
const PAST = LEASE_MS + RUNNER_LEASE_GRACE_MS;
const ORPHAN_GRACE_MS = 5 * 60_000;
const running: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };
const candidate: Checkpoint = { phase: "verifying", wipCommit: "head", baseSha: "base" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lease(db: Database, runId: string, generation: number, until: number) {
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    `INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until)
     VALUES(?1,'runner','workspace',?2,0,'command',?3)
     ON CONFLICT(run_id) DO UPDATE SET generation=?2,lease_until=?3,ended_at=NULL`,
    [runId, generation, until],
  );
}

async function leased(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  const item = insertQueuedItem(db, { id: "item", sessionKey: "session", now: START });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, START, running);
  lease(db, run.id, 1, START + LEASE_MS);
  return { db, item, run };
}

const pending = (db: Database) => listJobs(db).filter((job) => job.status === "pending");
const runnerWork = (db: Database, runId: string) =>
  db
    .query<{ endedAt: number | null }, [string]>(
      "SELECT ended_at AS endedAt FROM runner_work WHERE run_id=?",
    )
    .get(runId);

describe("follow-up after an expired runner lease", () => {
  test("running work resumes on the transient retry budget before the orphan grace", async () => {
    const { db, item, run } = await leased();
    const at = START + PAST;
    expect(await closeExpiredRunnerLeases(sqliteDb(db), at)).toEqual([run.id]);
    const current = getWorkItem(db, item.id)!;
    expect(current.state).toBe("recovering");
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(runnerWork(db, run.id)?.endedAt).toBe(at);
    const [job] = pending(db);
    expect(pending(db)).toHaveLength(1);
    expect(db.query("SELECT item_version AS version FROM job WHERE id=?").get(job!.id)).toEqual({
      version: current.version,
    });
    expect(job).toMatchObject({
      queue: JOB_KIND.resume,
      payload: { itemId: item.id, runId: run.id, reason: "transient_failure", retry: 1 },
    });
    expect(job!.runAt).toBeGreaterThan(at);
    expect(job!.runAt - at).toBeLessThan(ORPHAN_GRACE_MS);
    expect(await requeueOrphanedWork(sqliteDb(db), at + ORPHAN_GRACE_MS + 1)).toEqual([]);
    expect(await closeExpiredRunnerLeases(sqliteDb(db), at + 1)).toEqual([]);
    expect(pending(db)).toHaveLength(1);
  });

  test("a verifying candidate re-verifies without an implementer turn", async () => {
    const { db, item, run } = await leased();
    applyWorkItemEvent(db, item.id, "turn_ended");
    saveCheckpoint(db, item.id, candidate);
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    expect(pending(db)).toMatchObject([
      {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id, recheckHead: true, failClosed: true, retry: 1 },
      },
    ]);
  });

  test("verifying work without a candidate resumes execution", async () => {
    const { db, item, run } = await leased();
    applyWorkItemEvent(db, item.id, "turn_ended");
    saveCheckpoint(db, item.id, null);
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(getWorkItem(db, item.id)?.state).toBe("recovering");
    expect(pending(db).map((job) => job.queue)).toEqual([JOB_KIND.resume]);
  });

  test("a merge-queue run re-verifies its head and leaves the merge phase", async () => {
    const { db, item, run } = await leased();
    applyWorkItemEvent(db, item.id, "turn_ended");
    applyWorkItemEvent(db, item.id, "closeout_accepted");
    saveCheckpoint(db, item.id, { ...candidate, phase: "merge_queue" });
    enqueueJob(db, { queue: JOB_KIND.merge, payload: { itemId: item.id }, now: START });
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    const current = getWorkItem(db, item.id)!;
    expect(current.state).toBe("verifying");
    expect(current.checkpoint?.phase).toBe("verifying");
    expect(pending(db).filter((job) => job.queue === JOB_KIND.reverify)).toMatchObject([
      { payload: { itemId: item.id, recheckHead: true, failClosed: true } },
    ]);
    expect(pending(db).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
  });

  test("a valid pending job keeps ownership of the progress", async () => {
    const { db, item, run } = await leased();
    applyWorkItemEvent(db, item.id, "turn_ended");
    saveCheckpoint(db, item.id, candidate);
    enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: item.id }, now: START });
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(pending(db)).toHaveLength(1);
  });

  test("a live job owner keeps the run and gets no follow-up", async () => {
    const { db, item, run } = await leased();
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: item.id }, now: START });
    claimNextJob(db, { now: START, leaseMs: PAST + 60_000, queues: [JOB_KIND.resume] });
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([]);
    expect(getRun(db, run.id)?.status).toBe("active");
    expect(pending(db)).toEqual([]);
  });

  test("a claimed job whose lock lapsed before the transition does not block the follow-up", async () => {
    const { db, item, run } = await leased();
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: item.id }, now: START });
    expect(
      claimNextJob(db, { now: START, leaseMs: 1_000, queues: [JOB_KIND.resume] }),
    ).not.toBeNull();
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(pending(db)).toMatchObject([
      { queue: JOB_KIND.resume, payload: { reason: "transient_failure", retry: 1 } },
    ]);
  });

  test("a delivered result is left for import", async () => {
    const { db, item, run } = await leased();
    db.run(
      "INSERT INTO runner_result(run_id,generation,command_id,payload,received_at) VALUES(?,1,'command','{}',?)",
      [run.id, START],
    );
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([]);
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    expect(pending(db)).toEqual([]);
  });

  test("a stale run is closed without resuming the item", async () => {
    const { db, item, run } = await leased();
    setCurrentRun(db, item.id, "newer-run");
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    expect(pending(db)).toEqual([]);
  });

  test("a stopped item is not resumed", async () => {
    const { db, item, run } = await leased();
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [item.id]);
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(pending(db)).toEqual([]);
  });

  test("a paused item is not resumed", async () => {
    const { db, item, run } = await leased();
    applyWorkItemEvent(db, item.id, "pause");
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(getWorkItem(db, item.id)?.state).toBe("paused");
    expect(pending(db)).toEqual([]);
  });

  test("a pending restart decision is kept instead of resuming", async () => {
    const { db, item, run } = await leased();
    db.run("INSERT INTO restart_hold(item_id,session_id,requested_at) VALUES(?,?,?)", [
      item.id,
      "session",
      START,
    ]);
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(pending(db).map((job) => [job.queue, job.payload])).toEqual([
      ["item.ask", expect.objectContaining({ itemId: item.id, reason: "restart" })],
    ]);
  });

  test("repeated expiry spends the retry budget and then asks once", async () => {
    const { db, item, run } = await leased();
    let at = START + PAST;
    for (let generation = 1; generation <= MAX_TRANSIENT_RETRIES; generation++) {
      expect(await closeExpiredRunnerLeases(sqliteDb(db), at)).toEqual([run.id]);
      const [job] = pending(db);
      expect(job).toMatchObject({ queue: JOB_KIND.resume, payload: { retry: generation } });
      at = job!.runAt;
      const claimed = claimNextJob(db, { now: at, leaseMs: 1_000, queues: [JOB_KIND.resume] })!;
      applyWorkItemEvent(db, item.id, "recovered");
      markRun(db, run.id, "active", at);
      lease(db, run.id, generation + 1, at + LEASE_MS);
      completeJob(db, claimed, at);
      at += PAST;
    }
    expect(await closeExpiredRunnerLeases(sqliteDb(db), at)).toEqual([run.id]);
    const held = getWorkItem(db, item.id)!;
    expect(held.state).toBe("recovering");
    expect(await restartHold(sqliteDb(db), held)).not.toBeNull();
    expect(pending(db).map((job) => job.queue)).toEqual(["item.ask"]);
    expect(await recoverOnStartup(sqliteDb(db), at + 1)).toEqual([{ type: "ask_restart" }]);
    expect(await requeueOrphanedWork(sqliteDb(db), at + ORPHAN_GRACE_MS + 1)).toEqual([]);
    expect(pending(db).map((job) => job.queue)).toEqual(["item.ask"]);
  });

  test("a start after expiry keeps the follow-up and spends no resume", async () => {
    const { db, item, run } = await leased();
    expect(await closeExpiredRunnerLeases(sqliteDb(db), START + PAST)).toEqual([run.id]);
    expect(await recoverOnStartup(sqliteDb(db), START + PAST + 1)).toEqual([]);
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(0);
    expect(pending(db).map((job) => job.queue)).toEqual([JOB_KIND.resume]);
  });

  test("state, cleanup and the follow-up commit together across a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-lease-follow-up-"));
    dirs.push(dir);
    const path = join(dir, "paws.db");
    const first = await leased(path);
    first.db.run(
      `CREATE TRIGGER fail_follow_up BEFORE INSERT ON job BEGIN
         SELECT RAISE(ABORT, 'follow-up refused'); END`,
    );
    await expect(closeExpiredRunnerLeases(sqliteDb(first.db), START + PAST)).rejects.toThrow(
      "follow-up refused",
    );
    first.db.close();

    const second = openDatabase(path);
    expect(getWorkItem(second, "item")?.state).toBe("running");
    expect(getRun(second, first.run.id)?.status).toBe("active");
    expect(runnerWork(second, first.run.id)?.endedAt).toBeNull();
    second.run("DROP TRIGGER fail_follow_up");
    expect(await closeExpiredRunnerLeases(sqliteDb(second), START + PAST)).toEqual([first.run.id]);
    second.close();

    const third = openDatabase(path);
    expect(getWorkItem(third, "item")?.state).toBe("recovering");
    expect(getRun(third, first.run.id)?.status).toBe("lost");
    expect(runnerWork(third, first.run.id)?.endedAt).toBe(START + PAST);
    expect(pending(third)).toMatchObject([
      { queue: JOB_KIND.resume, payload: { reason: "transient_failure", retry: 1 } },
    ]);
    third.close();
  });
});
