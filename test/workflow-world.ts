import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  JOB_KIND,
  isTerminalWorkItemState,
  type Checkpoint,
  type WorkItemState,
} from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  beginMergeCall,
  bindWorkItemRepository,
  closeExpiredRunnerLeases,
  closeoutPolicyDigests,
  deferWorkItem,
  enqueueJob,
  finishCloseoutProgress,
  getRun,
  getWorkItem,
  insertQueuedItem,
  joinMergeQueue,
  listJobs,
  listWorkItems,
  markCloseoutAccepted,
  markRun,
  mergeCallInFlight,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
  type Job,
  type WorkItemRecord,
} from "../src/db";
import { ask } from "../src/loop";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { migratedDatabase, tempHome } from "./helpers";

export const T0 = 1_000_000_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const SETTLE_MS = 10 * MINUTE + RUNNER_LEASE_GRACE_MS;

export const AGENT_QUEUES: readonly string[] = [JOB_KIND.start, JOB_KIND.resume];
export const EXECUTION_QUEUES: readonly string[] = [
  JOB_KIND.start,
  JOB_KIND.resume,
  JOB_KIND.reverify,
  JOB_KIND.merge,
];
const HUMAN_HOLDS: ReadonlySet<WorkItemState> = new Set(["paused", "manual", "failed"]);

export const FIXTURES = [
  "queued",
  "running",
  "running_leased",
  "running_resumed",
  "verifying_candidate",
  "verifying_bare",
  "verifying_leased",
  "verifying_rejected",
  "recovering",
  "parked_wait",
  "transient_retry",
  "merge_queue",
  "merge_inflight",
  "merge_active_run",
  "paused",
  "awaiting_input",
  "awaiting_merge_help",
  "manual",
  "failed",
  "completed",
  "merged",
  "cancelled",
] as const;
export type Fixture = (typeof FIXTURES)[number];

const RUNNING: Checkpoint = { phase: "running", baseSha: "base", wipCommit: "wip", turn: 2 };
const CANDIDATE: Checkpoint = { phase: "verifying", baseSha: "base", wipCommit: "head" };
const MERGING: Checkpoint = { phase: "merge_queue", baseSha: "base", wipCommit: "head" };

export function leaseRunnerWork(
  db: Database,
  runId: string,
  now: number,
  leaseMs = MINUTE,
  generation = 1,
): void {
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    `INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET generation=excluded.generation,
       command_id=excluded.command_id,lease_until=excluded.lease_until,ended_at=NULL`,
    [runId, "runner", "workspace", generation, 0, `command-${runId}-${generation}`, now + leaseMs],
  );
  db.run("PRAGMA foreign_keys=ON");
}

export const JOB_LEASE_MS = 5 * MINUTE;
export const ORPHAN_GRACE_MS = 5 * MINUTE;

export function reapFencedJobs(db: Database, now: number): number {
  return db.run(
    `UPDATE job SET status='done', finished_at=?1, locked_by=NULL, locked_until=NULL
     WHERE status='running' AND locked_until<=?1 AND item_version IS NOT NULL
       AND item_version<>(SELECT version FROM work_item WHERE id=json_extract(job.payload,'$.itemId'))`,
    [now],
  ).changes;
}

export function claimedJob(db: Database, queue: string, payload: object, now: number): number {
  const id = enqueueJob(db, { queue, payload, now });
  db.run("UPDATE job SET status='running', attempts=1, locked_by=?, locked_until=? WHERE id=?", [
    `worker:${id}`,
    now + JOB_LEASE_MS,
    id,
  ]);
  return id;
}

function finishItemJobs(db: Database, itemId: string, now: number): void {
  db.run(
    `UPDATE job SET status='done', finished_at=?, locked_by=NULL, locked_until=NULL
     WHERE status IN ('pending','running') AND json_extract(payload,'$.itemId')=?`,
    [now, itemId],
  );
}

function identity(itemId: string, head: string, base = "base") {
  return { taskId: itemId, base, head, policyDigest: "policy", policyPath: null };
}

function accept(db: Database, id: string, now: number, head = "head"): void {
  finishCloseoutProgress(db, id, identity(id, head), "accepted", now);
  markCloseoutAccepted(db, id, head);
}

export function seedFixture(db: Database, fixture: Fixture, now: number, id = fixture): void {
  insertQueuedItem(db, { id, sessionKey: `session-${id}`, now });
  bindWorkItemRepository(db, id, {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  if (fixture === "queued") return;
  const { run } = beginImplementRun(db, id, now, RUNNING);
  if (fixture.startsWith("running") || fixture.startsWith("verifying"))
    claimedJob(db, JOB_KIND.start, { itemId: id, runId: run.id }, now);
  const toVerifying = () => {
    applyWorkItemEvent(db, id, "turn_ended", { now });
    saveCheckpoint(db, id, CANDIDATE);
  };
  const toMergeQueue = (runEnded = true) => {
    toVerifying();
    accept(db, id, now);
    applyWorkItemEvent(db, id, "closeout_accepted", { now });
    saveCheckpoint(db, id, MERGING);
    joinMergeQueue(db, { itemId: id, repository: "owner/repo", now });
    if (runEnded) markRun(db, run.id, "ended", now);
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      jobKey: `merge:${id}:head:accepted`,
      payload: { itemId: id, head: "head", summary: "Closeout accepted." },
      now,
    });
  };
  switch (fixture) {
    case "running":
      return;
    case "running_leased":
      leaseRunnerWork(db, run.id, now);
      return;
    case "running_resumed":
      db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=? WHERE id=?", [now, id]);
      return;
    case "verifying_candidate":
      toVerifying();
      return;
    case "verifying_bare":
      applyWorkItemEvent(db, id, "turn_ended", { now });
      return;
    case "verifying_leased":
      toVerifying();
      leaseRunnerWork(db, run.id, now);
      return;
    case "verifying_rejected":
      toVerifying();
      accept(db, id, now);
      finishCloseoutProgress(db, id, identity(id, "head", "newer"), "rejected", now + 1);
      return;
    case "recovering":
      applyWorkItemEvent(db, id, "lease_expired", { now });
      markRun(db, run.id, "lost", now);
      enqueueJob(db, {
        queue: JOB_KIND.resume,
        jobKey: `orphan:${id}:${now}`,
        payload: { itemId: id, runId: run.id, freshSession: true, reason: "orphaned" },
        now,
      });
      return;
    case "parked_wait":
      deferWorkItem(db, getWorkItem(db, id)!, {
        retry: 0,
        delayMs: 5 * MINUTE,
        handoff: null,
        message: null,
        now,
        capacityWait: { runnerIds: ["runner"], since: now, attempt: 1 },
      });
      return;
    case "transient_retry":
      deferWorkItem(db, getWorkItem(db, id)!, {
        retry: 2,
        delayMs: 5 * MINUTE,
        handoff: null,
        message: null,
        now,
      });
      return;
    case "merge_queue":
      toMergeQueue();
      return;
    case "merge_inflight":
      toMergeQueue();
      beginMergeCall(db, id, "head", now);
      return;
    case "merge_active_run":
      toMergeQueue(false);
      return;
    case "paused":
      applyWorkItemEvent(db, id, "pause", { now });
      return;
    case "awaiting_input":
      ask(db, { itemId: id, runId: run.id, sessionId: `session-${id}` }, "agent", "Which API?", {
        now,
      });
      return;
    case "awaiting_merge_help":
      toMergeQueue();
      finishItemJobs(db, id, now);
      ask(db, { itemId: id, runId: null, sessionId: `session-${id}` }, "ci-help", "CI failed.", {
        now,
      });
      return;
    case "manual":
      applyWorkItemEvent(db, id, "run_failed", { now });
      applyWorkItemEvent(db, id, "take_over", { now });
      return;
    case "failed":
      applyWorkItemEvent(db, id, "run_failed", { now });
      markRun(db, run.id, "ended", now);
      return;
    case "completed":
      applyWorkItemEvent(db, id, "answer_completed", { now });
      markRun(db, run.id, "ended", now);
      return;
    case "merged":
      toMergeQueue();
      applyWorkItemEvent(db, id, "merge_accepted", { now });
      finishItemJobs(db, id, now);
      return;
    case "cancelled":
      applyWorkItemEvent(db, id, "cancel", { now });
      db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [id]);
      markRun(db, run.id, "lost", now);
      return;
    default: {
      const exhaustive: never = fixture;
      throw new Error(`unknown fixture ${String(exhaustive)}`);
    }
  }
}

export class World {
  readonly path = join(tempHome(), "paws.db");
  db: Database;
  now: number;
  readonly trace: string[] = [];

  constructor(now = T0) {
    this.now = now;
    this.db = migratedDatabase(this.path);
  }

  seed(fixtures: readonly Fixture[]): this {
    for (const fixture of fixtures) seedFixture(this.db, fixture, this.now);
    return this;
  }

  crash(): void {
    this.trace.push("crash");
    this.db.close();
    this.db = openDatabase(this.path);
    migrate(this.db);
  }

  stop(): void {
    this.trace.push("stop");
    prepareShutdown(this.db, this.now);
    this.db.close();
    this.db = openDatabase(this.path);
    migrate(this.db);
  }

  start(): void {
    this.trace.push(`start@${this.now - T0}`);
    recoverOnStartup(this.db, this.now);
  }

  sweep(): void {
    this.trace.push(`sweep@${this.now - T0}`);
    reapFencedJobs(this.db, this.now);
    closeExpiredRunnerLeases(this.db, this.now);
    requeueOrphanedWork(this.db, this.now);
  }

  settle(): void {
    let quiet = 0;
    for (let round = 0; round < 24 && quiet < 3; round++) {
      const before = JSON.stringify(dump(this.db, ["work_item", "job", "runner_work"]));
      this.sweep();
      this.advance(ORPHAN_GRACE_MS + 1);
      quiet =
        JSON.stringify(dump(this.db, ["work_item", "job", "runner_work"])) === before
          ? quiet + 1
          : 0;
    }
  }

  renewJobLeases(): void {
    this.db.run("UPDATE job SET locked_until=? WHERE status='running'", [this.now + JOB_LEASE_MS]);
  }

  advance(ms: number): void {
    this.trace.push(`advance ${ms}`);
    this.now += ms;
  }

  close(): void {
    this.db.close();
  }
}

export type ItemFacts = {
  state: WorkItemState;
  version: number;
  recoveryAttempts: number;
  acceptedHead: string | null;
  checkpoint: Checkpoint | null;
  runStatus: string | null;
  cancelRequested: boolean;
  liveJobs: string[];
  questions: number;
  restartHold: boolean;
  mergeCall: boolean;
};

function liveJobsOf(db: Database, item: WorkItemRecord): Job[] {
  return listJobs(db).filter(
    (job) =>
      (job.payload as { itemId?: unknown } | null)?.itemId === item.id &&
      (job.status === "running" || job.status === "pending"),
  );
}

export function progressJobs(db: Database, item: WorkItemRecord, now: number): Job[] {
  const current = new Set(
    db
      .query<{ id: number }, [string, number, number]>(
        `SELECT id FROM job WHERE json_extract(payload,'$.itemId')=?1
         AND ((status='running' AND (locked_until>?3 OR item_version IS NULL OR item_version=?2))
         OR (status='pending' AND (item_version IS NULL OR item_version=?2
           OR queue IN ('${JOB_KIND.command}','${JOB_KIND.reverify}'))))`,
      )
      .all(item.id, item.version, now)
      .map((row) => row.id),
  );
  return liveJobsOf(db, item).filter((job) => current.has(job.id));
}

function actionableQuestions(db: Database, itemId: string): number {
  return db
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM question WHERE item_id=? AND cancelled_at IS NULL
       AND status IN ('open','queued')`,
    )
    .get(itemId)!.n;
}

function pendingAsk(db: Database, itemId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM job WHERE queue='item.ask' AND status IN ('pending','running')
         AND json_extract(payload,'$.itemId')=?`,
      )
      .get(itemId) !== null
  );
}

function liveRunnerWork(db: Database, item: WorkItemRecord, now: number): boolean {
  return (
    item.currentRunId !== null &&
    db
      .query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL AND lease_until>?")
      .get(item.currentRunId, now - RUNNER_LEASE_GRACE_MS) !== null
  );
}

export function factsOf(db: Database, id: string): ItemFacts {
  const item = getWorkItem(db, id)!;
  return {
    state: item.state,
    version: item.version,
    recoveryAttempts: item.recoveryAttempts,
    acceptedHead: item.acceptedHead,
    checkpoint: item.checkpoint,
    runStatus: item.currentRunId === null ? null : (getRun(db, item.currentRunId)?.status ?? null),
    cancelRequested: item.cancelRequested,
    liveJobs: liveJobsOf(db, item)
      .map((job) => `${job.queue}:${job.status}`)
      .sort(),
    questions: actionableQuestions(db, id),
    restartHold: restartHold(db, item) !== null,
    mergeCall: mergeCallInFlight(db, id),
  };
}

export const KNOWN_GAP = "known gap: ";
export const ORPHANED_MERGE_CALL =
  "orphan recovery re-verifies an item whose merge call outcome is unknown once its merge job ended";
export const STARTUP_RESUME_DUPLICATE =
  "startup adds a process_restart resume beside a resume that is already pending";

export type Checks = { liveness?: boolean };

export function unexpectedViolations(db: Database, now: number, checks: Checks = {}): string[] {
  return violations(db, now, checks).filter((message) => !message.includes(KNOWN_GAP));
}

const DUMPED_TABLES = [
  "work_item",
  "work_item_event",
  "job",
  "run",
  "question",
  "runner_work",
  "merge_call",
  "merge_queue_entry",
  "outbox",
  "paws_alive",
];

export function dump(
  db: Database,
  only: readonly string[] = DUMPED_TABLES,
): Record<string, unknown[]> {
  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  return Object.fromEntries(
    only
      .filter((table) => tables.has(table))
      .map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

export function failWrites(db: Database, point: string): void {
  db.run(
    `CREATE TEMP TRIGGER injected_write_failure ${point} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`,
  );
}

export function allowWrites(db: Database): void {
  db.run("DROP TRIGGER IF EXISTS injected_write_failure");
}

export function violations(db: Database, now: number, { liveness = true }: Checks = {}): string[] {
  const found: string[] = [];
  for (const item of listWorkItems(db)) {
    const say = (message: string) => found.push(`${item.id} (${item.state}): ${message}`);
    const live = liveJobsOf(db, item);
    const execution = live.filter((job) => EXECUTION_QUEUES.includes(job.queue));
    const progress = progressJobs(db, item, now).filter((job) =>
      EXECUTION_QUEUES.includes(job.queue),
    );
    const questions = actionableQuestions(db, item.id);
    const hold = restartHold(db, item) !== null;
    const merging = mergeCallInFlight(db, item.id);

    for (const queues of [AGENT_QUEUES, [JOB_KIND.reverify], [JOB_KIND.merge]]) {
      const open = progress.filter((job) => job.status === "pending" && queues.includes(job.queue));
      const newest = open.at(-1)?.payload as { reason?: string } | undefined;
      if (open.length > 1 && queues === AGENT_QUEUES && newest?.reason === "process_restart")
        say(`${KNOWN_GAP}${STARTUP_RESUME_DUPLICATE}`);
      else if (open.length > 1) say(`${open.length} live ${queues.join("/")} jobs`);
    }
    if (questions > 1) say(`${questions} actionable questions`);

    if (isTerminalWorkItemState(item.state)) {
      if (execution.length > 0) say(`terminal item has live ${execution.map((j) => j.queue)}`);
      if (questions > 0) say("terminal item has an actionable question");
      if (merging && item.state !== "cancelled") say("terminal item keeps a merge call");
      continue;
    }
    if (HUMAN_HOLDS.has(item.state)) {
      if (execution.length > 0) say(`human hold has live ${execution.map((j) => j.queue)}`);
      continue;
    }
    if (item.state === "awaiting_input") {
      if (execution.length > 0) say(`question hold has live ${execution.map((j) => j.queue)}`);
      if (liveness && questions === 0 && !pendingAsk(db, item.id))
        say("awaiting input without a question");
      continue;
    }
    if (hold) {
      if (execution.length > 0) say(`restart hold has live ${execution.map((j) => j.queue)}`);
      if (liveness && questions === 0 && !pendingAsk(db, item.id))
        say("restart hold without a question");
      continue;
    }
    if (item.state === "queued") continue;
    if (item.cancelRequested) continue;
    if (liveness && progress.length === 0 && !liveRunnerWork(db, item, now))
      say(`no owner: no current job and no live runner work (${live.map((j) => j.queue)})`);
    if (item.state === "merge_queue") {
      if (item.acceptedHead === null) say("in the merge queue without an accepted head");
      else {
        const verdict = closeoutPolicyDigests(db, item.id, item.acceptedHead)?.decision ?? null;
        if (verdict !== null && verdict !== "accepted")
          say(`in the merge queue at a head whose latest verdict is ${verdict}`);
      }
      if (progress.some((job) => AGENT_QUEUES.includes(job.queue)))
        say("merge queue item has a live agent job");
    }
    if (merging && item.state !== "merge_queue")
      say(
        item.state === "verifying"
          ? `${KNOWN_GAP}${ORPHANED_MERGE_CALL}`
          : "merge call outcome unknown outside the lane",
      );
    if (
      liveness &&
      merging &&
      item.state === "merge_queue" &&
      !progress.some((job) => job.queue === JOB_KIND.merge)
    )
      say("merge call outcome unknown without a merge job to read it");
  }
  return found;
}
