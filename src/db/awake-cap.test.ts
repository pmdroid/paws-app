import { describe, expect, test } from "bun:test";
import { FakeClock } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  configureWorkItem,
  enqueueJob,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  recoverOnStartup,
  saveCheckpoint,
  setCurrentRun,
} from "./index";

const MINUTE = 60_000;

function acceptedItem(maxAwakeMs: number) {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    maxAwakeMs,
    now: clock.now(),
  });
  const { run } = beginImplementRun(db, item.id, clock.now());
  accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(10 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now());
  applyWorkItemEvent(db, item.id, "turn_ended");
  clock.advance(5 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now());
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  markCloseoutAccepted(db, item.id, "accepted");
  saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
  return { clock, db, item, run };
}

describe("awake-time cap after Closeout accepted the work", () => {
  test("re-verification after a restart doesn't add awake time", () => {
    const { clock, db, item } = acceptedItem(3 * 60 * MINUTE);
    expect(getWorkItem(db, item.id)?.awakeMs).toBe(15 * MINUTE);

    expect(recoverOnStartup(db, clock.now())).toEqual([{ type: "reverify" }]);
    const restarted = getWorkItem(db, item.id);
    expect(restarted?.state).toBe("verifying");
    expect(restarted?.checkpoint?.phase).toBe("verifying");
    expect(listJobs(db).some((job) => job.queue === "run.reverify")).toBe(true);

    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      awakeMs: 15 * MINUTE,
      agentMs: 10 * MINUTE,
      closeoutMs: 5 * MINUTE,
      recheckMs: 32 * MINUTE,
    });
  });

  test("past the cap, accepted work keeps publishing, merging and re-verifying", () => {
    const { clock, db, item } = acceptedItem(3 * 60 * MINUTE);
    configureWorkItem(db, item.id, { maxAwakeMs: MINUTE });
    clock.advance(4 * 60 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(false);
    expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");

    recoverOnStartup(db, clock.now());
    clock.advance(60 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(false);

    saveCheckpoint(db, item.id, { phase: "verifying", baseSha: "base", wipCommit: "newer" });
    clock.advance(60 * MINUTE);
    const verifying = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(verifying.capped).toBe(false);
    expect(verifying.item.state).toBe("verifying");
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toEqual([]);
  });

  test("a resumed agent at the cap asks in Linear instead of failing", () => {
    const { clock, db, item, run } = acceptedItem(30 * MINUTE);
    applyWorkItemEvent(db, item.id, "ejected");
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(20 * MINUTE);

    enqueueJob(db, { queue: "run.resume", payload: { itemId: item.id }, now: clock.now() });
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result).toMatchObject({ capped: false, asked: true, stopAgent: true });
    expect(listJobs(db).filter((job) => job.status === "pending")).toEqual([]);
    expect(result.item).toMatchObject({ state: "awaiting_input", cancelRequested: false });
    expect(getRun(db, run.id)?.status).toBe("ended");
    const question = db
      .query<{ kind: string; status: string; options: string; body: string }, [string]>(
        "SELECT kind, status, options, body FROM question WHERE item_id = ?",
      )
      .all(item.id);
    expect(question).toHaveLength(1);
    expect(question[0]).toMatchObject({ kind: "time-limit", status: "open" });
    expect(JSON.parse(question[0]!.options)).toEqual(["Continue", "Stop"]);
    expect(question[0]!.body).toBe(
      "Time limit reached (30 min awake); continue or stop? Closeout already accepted this task's work, so Paws did not fail it. Counted: agent turns 30 min, Closeout 5 min. Continue gives the agent another 1 h. Stop ends the task and keeps the accepted work on its branch.",
    );
    const asked = listOutbox(db).filter((row) => row.op === "elicitation");
    expect(asked).toHaveLength(1);
    expect(listOutbox(db).some((row) => (row.payload as { kind?: string }).kind === "error")).toBe(
      false,
    );

    clock.advance(60 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item).toMatchObject({
      state: "awaiting_input",
      waitingMs: 60 * MINUTE,
    });
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toHaveLength(1);
  });

  test("without an accepted candidate the cap still fails and says how the time was spent", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 30 * MINUTE, now: 0 });
    beginImplementRun(db, item.id, clock.now());
    accrueAwake(db, item.id, clock.mono(), clock.now());
    applyWorkItemEvent(db, item.id, "blocking_question");
    clock.advance(90 * MINUTE);
    accrueAwake(db, item.id, clock.mono(), clock.now());
    applyWorkItemEvent(db, item.id, "answer_received");
    clock.advance(30 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(true);
    expect(listOutbox(db).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: "Run hit the awake time cap (30 min). Counted: agent turns 30 min, Closeout 0 min. Not counted: waiting for answers 1 h 30 min.",
    });
  });

  test("a task Closeout accepted before the upgrade is still protected after a restart", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 30 * MINUTE, now: 0 });
    beginImplementRun(db, item.id, clock.now());
    applyWorkItemEvent(db, item.id, "turn_ended");
    applyWorkItemEvent(db, item.id, "closeout_accepted");
    saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
    for (const column of ["accepted_head", "agent_ms", "closeout_ms", "waiting_ms", "recheck_ms"])
      db.run(`ALTER TABLE work_item DROP COLUMN ${column}`);
    db.run("DELETE FROM schema_migration WHERE id = '115_work_item_awake_breakdown'");
    db.run("UPDATE work_item SET awake_ms = ? WHERE id = ?", [29 * MINUTE, item.id]);

    migrate(db);
    expect(getWorkItem(db, item.id)?.acceptedHead).toBe("accepted");
    recoverOnStartup(db, clock.now());
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({ awakeMs: 29 * MINUTE, recheckMs: 32 * MINUTE });
  });

  test("without a Linear session, a resumed agent at the cap pauses instead of failing", () => {
    const { clock, db, item, run } = acceptedItem(30 * MINUTE);
    db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [item.id]);
    applyWorkItemEvent(db, item.id, "ejected");
    setCurrentRun(db, item.id, run.id);
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(20 * MINUTE);

    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      state: "paused",
      cancelRequested: false,
      maxAwakeMs: 35 * MINUTE + 60 * MINUTE,
    });
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect(listOutbox(db).some((row) => (row.payload as { kind?: string }).kind === "error")).toBe(
      false,
    );
    expect(listOutbox(db).at(-1)?.payload).toMatchObject({
      kind: "thought",
      body: expect.stringMatching(/^Paused at the time limit\. /),
    });
  });
});
