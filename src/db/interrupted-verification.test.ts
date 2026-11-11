import { describe, expect, test } from "bun:test";
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
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
  sqliteDb,
} from "./index";

const NOW = 1_000_000;

function verifying(candidate = true) {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "item", sessionKey: "session", now: NOW });
  const { run } = beginImplementRun(db, item.id, NOW);
  applyWorkItemEvent(db, item.id, "turn_ended");
  if (candidate)
    saveCheckpoint(db, item.id, { phase: "verifying", baseSha: "base", wipCommit: "head" });
  return { db, item: getWorkItem(db, item.id)!, run };
}

const pending = (db: ReturnType<typeof verifying>["db"]) =>
  listJobs(db).filter((job) => job.status === "pending");

describe("interrupted verification", () => {
  test("a clean shutdown keeps the candidate in verifying and the next start re-verifies it", async () => {
    const { db, item, run } = verifying();
    await prepareShutdown(sqliteDb(db), NOW + 1);
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(await recoverOnStartup(sqliteDb(db), NOW + 2)).toEqual([
      { type: "reverify", resumed: true },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "verifying", recoveryAttempts: 1 });
    expect(pending(db).map((job) => job.queue)).toEqual([JOB_KIND.reverify]);
  });

  test("a crash start re-verifies the candidate once and then asks", async () => {
    const { db, item } = verifying();
    expect(await recoverOnStartup(sqliteDb(db), NOW + 1)).toEqual([
      { type: "reverify", resumed: true },
    ]);
    expect(await recoverOnStartup(sqliteDb(db), NOW + 2)).toEqual([{ type: "ask_restart" }]);
    expect(listJobs(db).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
    const held = getWorkItem(db, item.id)!;
    expect(held.state).toBe("recovering");
    expect(restartHold(db, held)).not.toBeNull();
  });

  test("a start leaves a backed-off re-verify of a deferred candidate where it is", async () => {
    const { db, item } = verifying();
    await deferWorkItem(sqliteDb(db), item, {
      retry: 1,
      delayMs: 60_000,
      handoff: null,
      message: null,
      now: NOW,
    });
    await prepareShutdown(sqliteDb(db), NOW + 1);
    expect(await recoverOnStartup(sqliteDb(db), NOW + 2)).toEqual([]);
    expect(pending(db)).toMatchObject([
      { queue: JOB_KIND.reverify, runAt: NOW + 60_000, payload: { retry: 1 } },
    ]);
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(0);
  });

  test("a verifying item without a recorded candidate still moves to recovering", async () => {
    const { db, item } = verifying(false);
    await prepareShutdown(sqliteDb(db), NOW + 1);
    expect(getWorkItem(db, item.id)?.state).toBe("recovering");
  });

  test("an expired runner lease keeps the candidate verifying, and re-verifies it without waiting for orphan recovery", async () => {
    const { db, item, run } = verifying();
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
      [run.id, "runner", "workspace", 1, 0, "command", NOW + 60_000],
    );
    db.run(
      "INSERT INTO job(queue,payload,status,run_at,created_at,finished_at) VALUES(?,?,?,?,?,?)",
      [JOB_KIND.start, JSON.stringify({ itemId: item.id }), "done", NOW, NOW, NOW],
    );
    const later = NOW + 60_000 + RUNNER_LEASE_GRACE_MS + 10 * 60_000;
    expect(await closeExpiredRunnerLeases(sqliteDb(db), later)).toEqual([run.id]);
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(pending(db)).toMatchObject([
      { queue: JOB_KIND.reverify, payload: { itemId: item.id, recheckHead: true } },
    ]);
    expect(await requeueOrphanedWork(sqliteDb(db), later)).toEqual([]);
  });

  test("Stop wins over a kept candidate", async () => {
    const { db, item } = verifying();
    db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
    await prepareShutdown(sqliteDb(db), NOW + 1);
    expect(await requeueOrphanedWork(sqliteDb(db), NOW + 60 * 60_000)).toEqual([]);
  });
});
