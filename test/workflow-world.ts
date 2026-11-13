import { join } from "node:path";
import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
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
  bindWorkItemRepositorySteps,
  closeExpiredRunnerLeasesSteps,
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
  openPawsStore,
  pgSchema,
  prepareShutdownSteps,
  recoverOnStartupSteps,
  requeueOrphanedWorkSteps,
  restartHold,
  saveCheckpoint,
  type Job,
  type Db,
  type PgDb,
  type WorkItemRecord,
} from "../src/db";
import { askSteps } from "../src/loop";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { tempHome } from "./helpers";
import { copyMigratedPglite } from "./pglite";

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

const { job, question, runnerWork, workItem } = pgSchema;

const orm = (db: Db) => (db as PgDb).orm;

const itemOf = sql`${job.payload}->>'itemId'`;

export async function leaseRunnerWork(
  db: Db,
  runId: string,
  now: number,
  leaseMs = MINUTE,
  generation = 1,
): Promise<void> {
  const lease = {
    generation,
    commandId: `command-${runId}-${generation}`,
    leaseUntil: now + leaseMs,
  };
  await db.transaction(function* (q) {
    yield* q.exec(q.orm.execute(sql`SET LOCAL session_replication_role = replica`));
    yield* q.exec(
      q.orm
        .insert(q.t.runnerWork)
        .values({ runId, runnerId: "runner", workspaceId: "workspace", runnerFence: 0, ...lease })
        .onConflictDoUpdate({ target: q.t.runnerWork.runId, set: { ...lease, endedAt: null } }),
    );
  });
}

export const JOB_LEASE_MS = 5 * MINUTE;
export const ORPHAN_GRACE_MS = 5 * MINUTE;

export async function reapFencedJobs(db: Db, now: number): Promise<number> {
  const reaped = await orm(db)
    .update(job)
    .set({ status: "done", finishedAt: now, lockedBy: null, lockedUntil: null })
    .where(
      and(
        eq(job.status, "running"),
        lte(job.lockedUntil, now),
        ne(
          job.itemVersion,
          sql`(SELECT ${workItem.version} FROM ${workItem} WHERE ${workItem.id} = ${itemOf})`,
        ),
      ),
    )
    .returning({ id: job.id });
  return reaped.length;
}

export async function claimedJob(
  db: Db,
  queue: string,
  payload: object,
  now: number,
): Promise<number> {
  const id = await enqueueJob(db, { queue, payload, now });
  await orm(db)
    .update(job)
    .set({
      status: "running",
      attempts: 1,
      lockedBy: `worker:${id}`,
      lockedUntil: now + JOB_LEASE_MS,
    })
    .where(eq(job.id, id));
  return id;
}

async function finishItemJobs(db: Db, itemId: string, now: number): Promise<void> {
  await orm(db)
    .update(job)
    .set({ status: "done", finishedAt: now, lockedBy: null, lockedUntil: null })
    .where(and(inArray(job.status, ["pending", "running"]), eq(itemOf, itemId)));
}

function identity(itemId: string, head: string, base = "base") {
  return { taskId: itemId, base, head, policyDigest: "policy", policyPath: null };
}

async function accept(db: Db, id: string, now: number, head = "head"): Promise<void> {
  await finishCloseoutProgress(db, id, identity(id, head), "accepted", now);
  await markCloseoutAccepted(db, id, head);
}

export async function seedFixture(
  db: Db,
  fixture: Fixture,
  now: number,
  id = fixture,
): Promise<void> {
  await insertQueuedItem(db, { id, sessionKey: `session-${id}`, now });
  await db.transaction((q) =>
    bindWorkItemRepositorySteps(q, id, {
      owner: "owner",
      repo: "repo",
      remoteUrl: "https://example.invalid/repo.git",
    }),
  );
  if (fixture === "queued") return;
  const { run } = await beginImplementRun(db, id, now, RUNNING);
  if (fixture.startsWith("running") || fixture.startsWith("verifying"))
    await claimedJob(db, JOB_KIND.start, { itemId: id, runId: run.id }, now);
  const toVerifying = async () => {
    await applyWorkItemEvent(db, id, "turn_ended", { now });
    await saveCheckpoint(db, id, CANDIDATE);
  };
  const toMergeQueue = async (runEnded = true) => {
    await toVerifying();
    await accept(db, id, now);
    await applyWorkItemEvent(db, id, "closeout_accepted", { now });
    await saveCheckpoint(db, id, MERGING);
    await joinMergeQueue(db, { itemId: id, repository: "owner/repo", now });
    if (runEnded) await markRun(db, run.id, "ended", now);
    await enqueueJob(db, {
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
      await leaseRunnerWork(db, run.id, now);
      return;
    case "running_resumed":
      await orm(db)
        .update(workItem)
        .set({ recoveryAttempts: 1, resumedAt: now })
        .where(eq(workItem.id, id));
      return;
    case "verifying_candidate":
      await toVerifying();
      return;
    case "verifying_bare":
      await applyWorkItemEvent(db, id, "turn_ended", { now });
      return;
    case "verifying_leased":
      await toVerifying();
      await leaseRunnerWork(db, run.id, now);
      return;
    case "verifying_rejected":
      await toVerifying();
      await accept(db, id, now);
      await finishCloseoutProgress(db, id, identity(id, "head", "newer"), "rejected", now + 1);
      return;
    case "recovering":
      await applyWorkItemEvent(db, id, "lease_expired", { now });
      await markRun(db, run.id, "lost", now);
      await enqueueJob(db, {
        queue: JOB_KIND.resume,
        jobKey: `orphan:${id}:${now}`,
        payload: { itemId: id, runId: run.id, freshSession: true, reason: "orphaned" },
        now,
      });
      return;
    case "parked_wait":
      await deferWorkItem(db, (await getWorkItem(db, id))!, {
        retry: 0,
        delayMs: 5 * MINUTE,
        handoff: null,
        message: null,
        now,
        capacityWait: { runnerIds: ["runner"], since: now, attempt: 1 },
      });
      return;
    case "transient_retry":
      await deferWorkItem(db, (await getWorkItem(db, id))!, {
        retry: 2,
        delayMs: 5 * MINUTE,
        handoff: null,
        message: null,
        now,
      });
      return;
    case "merge_queue":
      await toMergeQueue();
      return;
    case "merge_inflight":
      await toMergeQueue();
      await beginMergeCall(db, id, "head", now);
      return;
    case "merge_active_run":
      await toMergeQueue(false);
      return;
    case "paused":
      await applyWorkItemEvent(db, id, "pause", { now });
      return;
    case "awaiting_input":
      await db.transaction((q) =>
        askSteps(
          q,
          { itemId: id, runId: run.id, sessionId: `session-${id}` },
          "agent",
          "Which API?",
          {
            now,
          },
        ),
      );
      return;
    case "awaiting_merge_help":
      await toMergeQueue();
      await finishItemJobs(db, id, now);
      await db.transaction((q) =>
        askSteps(
          q,
          { itemId: id, runId: null, sessionId: `session-${id}` },
          "ci-help",
          "CI failed.",
          {
            now,
          },
        ),
      );
      return;
    case "manual":
      await applyWorkItemEvent(db, id, "run_failed", { now });
      await applyWorkItemEvent(db, id, "take_over", { now });
      return;
    case "failed":
      await applyWorkItemEvent(db, id, "run_failed", { now });
      await markRun(db, run.id, "ended", now);
      return;
    case "completed":
      await applyWorkItemEvent(db, id, "answer_completed", { now });
      await markRun(db, run.id, "ended", now);
      return;
    case "merged":
      await toMergeQueue();
      await applyWorkItemEvent(db, id, "merge_accepted", { now });
      await finishItemJobs(db, id, now);
      return;
    case "cancelled":
      await applyWorkItemEvent(db, id, "cancel", { now });
      await orm(db).update(workItem).set({ cancelRequested: 1 }).where(eq(workItem.id, id));
      await markRun(db, run.id, "lost", now);
      return;
    default: {
      const exhaustive: never = fixture;
      throw new Error(`unknown fixture ${String(exhaustive)}`);
    }
  }
}

export class World {
  readonly path = join(tempHome(), "pglite");
  db!: Db;
  now: number;
  readonly trace: string[] = [];
  private store: { store: Db; close(): Promise<void> } | undefined;

  private constructor(now: number) {
    this.now = now;
  }

  static async open(now = T0): Promise<World> {
    const world = new World(now);
    await copyMigratedPglite(world.path);
    await world.reopen();
    return world;
  }

  static async seeded(fixtures: readonly Fixture[], now = T0): Promise<World> {
    const world = await World.open(now);
    for (const fixture of fixtures) await seedFixture(world.db, fixture, world.now);
    return world;
  }

  private async reopen(): Promise<void> {
    await this.store?.close();
    this.store = await openPawsStore({ url: null, pgliteDir: this.path });
    this.db = this.store.store;
  }

  async crash(): Promise<void> {
    this.trace.push("crash");
    await this.reopen();
  }

  async stop(): Promise<void> {
    this.trace.push("stop");
    await this.db.transaction((q) => prepareShutdownSteps(q, this.now, undefined));
    await this.reopen();
  }

  async start(): Promise<void> {
    this.trace.push(`start@${this.now - T0}`);
    const wake = { armed: false };
    await this.db.transaction((q) =>
      recoverOnStartupSteps(q, this.now, undefined, undefined, wake),
    );
  }

  async sweep(): Promise<void> {
    this.trace.push(`sweep@${this.now - T0}`);
    await reapFencedJobs(this.db, this.now);
    await this.db.transaction((q) => closeExpiredRunnerLeasesSteps(q, this.now));
    await this.db.run((q) => requeueOrphanedWorkSteps(q, this.now));
  }

  async settle(): Promise<void> {
    let quiet = 0;
    for (let round = 0; round < 24 && quiet < 3; round++) {
      const before = JSON.stringify(await dump(this.db, ["work_item", "job", "runner_work"]));
      await this.sweep();
      this.advance(ORPHAN_GRACE_MS + 1);
      quiet =
        JSON.stringify(await dump(this.db, ["work_item", "job", "runner_work"])) === before
          ? quiet + 1
          : 0;
    }
  }

  async renewJobLeases(): Promise<void> {
    await orm(this.db)
      .update(job)
      .set({ lockedUntil: this.now + JOB_LEASE_MS })
      .where(eq(job.status, "running"));
  }

  advance(ms: number): void {
    this.trace.push(`advance ${ms}`);
    this.now += ms;
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = undefined;
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

async function liveJobsOf(db: Db, item: WorkItemRecord): Promise<Job[]> {
  return (await listJobs(db)).filter(
    (job) =>
      (job.payload as { itemId?: unknown } | null)?.itemId === item.id &&
      (job.status === "running" || job.status === "pending"),
  );
}

export async function progressJobs(db: Db, item: WorkItemRecord, now: number): Promise<Job[]> {
  const current = new Set(
    (
      await orm(db)
        .select({ id: job.id })
        .from(job)
        .where(
          and(
            eq(itemOf, item.id),
            or(
              and(
                eq(job.status, "running"),
                or(
                  gt(job.lockedUntil, now),
                  isNull(job.itemVersion),
                  eq(job.itemVersion, item.version),
                ),
              ),
              and(
                eq(job.status, "pending"),
                or(
                  isNull(job.itemVersion),
                  eq(job.itemVersion, item.version),
                  inArray(job.queue, [JOB_KIND.command, JOB_KIND.reverify]),
                ),
              ),
            ),
          ),
        )
    ).map((row) => row.id),
  );
  return (await liveJobsOf(db, item)).filter((job) => current.has(job.id));
}

async function actionableQuestions(db: Db, itemId: string): Promise<number> {
  const [row] = await orm(db)
    .select({ n: sql<number>`count(*)::int` })
    .from(question)
    .where(
      and(
        eq(question.itemId, itemId),
        isNull(question.cancelledAt),
        inArray(question.status, ["open", "queued"]),
      ),
    );
  return row!.n;
}

async function pendingAsk(db: Db, itemId: string): Promise<boolean> {
  const rows = await orm(db)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        eq(job.queue, "item.ask"),
        inArray(job.status, ["pending", "running"]),
        eq(itemOf, itemId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function liveRunnerWork(db: Db, item: WorkItemRecord, now: number): Promise<boolean> {
  if (item.currentRunId === null) return false;
  const rows = await orm(db)
    .select({ runId: runnerWork.runId })
    .from(runnerWork)
    .where(
      and(
        eq(runnerWork.runId, item.currentRunId),
        isNull(runnerWork.endedAt),
        gt(runnerWork.leaseUntil, now - RUNNER_LEASE_GRACE_MS),
      ),
    );
  return rows.length > 0;
}

export async function factsOf(db: Db, id: string): Promise<ItemFacts> {
  const item = (await getWorkItem(db, id))!;
  return {
    state: item.state,
    version: item.version,
    recoveryAttempts: item.recoveryAttempts,
    acceptedHead: item.acceptedHead,
    checkpoint: item.checkpoint,
    runStatus:
      item.currentRunId === null ? null : ((await getRun(db, item.currentRunId))?.status ?? null),
    cancelRequested: item.cancelRequested,
    liveJobs: (await liveJobsOf(db, item)).map((job) => `${job.queue}:${job.status}`).sort(),
    questions: await actionableQuestions(db, id),
    restartHold: (await restartHold(db, item)) !== null,
    mergeCall: await mergeCallInFlight(db, id),
  };
}

export const KNOWN_GAP = "known gap: ";
export const ORPHANED_MERGE_CALL =
  "orphan recovery re-verifies an item whose merge call outcome is unknown once its merge job ended";
export const STARTUP_RESUME_DUPLICATE =
  "startup adds a process_restart resume beside a resume that is already pending";

export type Checks = { liveness?: boolean };

export async function unexpectedViolations(
  db: Db,
  now: number,
  checks: Checks = {},
): Promise<string[]> {
  return (await violations(db, now, checks)).filter((message) => !message.includes(KNOWN_GAP));
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

export async function dump(
  db: Db,
  only: readonly string[] = DUMPED_TABLES,
): Promise<Record<string, unknown[]>> {
  const tables = new Set(
    (
      await orm(db)
        .select({ name: sql<string>`table_name` })
        .from(sql`information_schema.tables`)
        .where(sql`table_schema = current_schema()`)
    ).map((row) => row.name),
  );
  const dumped: Record<string, unknown[]> = {};
  for (const table of only.filter((name) => tables.has(name)))
    dumped[table] = (
      await orm(db)
        .select({ row: sql<unknown>`to_jsonb(t)` })
        .from(sql`${sql.identifier(table)} t`)
        .orderBy(sql`t::text`)
    ).map((entry) => entry.row);
  return dumped;
}

export function injectedWriteFailure(error: unknown): boolean {
  return String((error as Error | undefined)?.cause ?? error).includes("injected write failure");
}

export async function failWrites(db: Db, point: string): Promise<void> {
  await orm(db).execute(
    sql`CREATE OR REPLACE FUNCTION injected_write_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END $$ LANGUAGE plpgsql`,
  );
  await orm(db).execute(
    sql.raw(
      `CREATE TRIGGER injected_write_failure ${point} FOR EACH ROW EXECUTE FUNCTION injected_write_failure()`,
    ),
  );
}

export async function allowWrites(db: Db): Promise<void> {
  await orm(db).execute(
    sql`DO $$ DECLARE target regclass; BEGIN
      FOR target IN SELECT tgrelid::regclass FROM pg_trigger WHERE tgname = 'injected_write_failure' LOOP
        EXECUTE format('DROP TRIGGER injected_write_failure ON %s', target);
      END LOOP;
    END $$`,
  );
}

export async function violations(
  db: Db,
  now: number,
  { liveness = true }: Checks = {},
): Promise<string[]> {
  const found: string[] = [];
  for (const item of await listWorkItems(db)) {
    const say = (message: string) => found.push(`${item.id} (${item.state}): ${message}`);
    const live = await liveJobsOf(db, item);
    const execution = live.filter((job) => EXECUTION_QUEUES.includes(job.queue));
    const progress = (await progressJobs(db, item, now)).filter((job) =>
      EXECUTION_QUEUES.includes(job.queue),
    );
    const questions = await actionableQuestions(db, item.id);
    const hold = (await restartHold(db, item)) !== null;
    const merging = await mergeCallInFlight(db, item.id);

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
      if (liveness && questions === 0 && !(await pendingAsk(db, item.id)))
        say("awaiting input without a question");
      continue;
    }
    if (hold) {
      if (execution.length > 0) say(`restart hold has live ${execution.map((j) => j.queue)}`);
      if (liveness && questions === 0 && !(await pendingAsk(db, item.id)))
        say("restart hold without a question");
      continue;
    }
    if (item.state === "queued") continue;
    if (item.cancelRequested) continue;
    if (liveness && progress.length === 0 && !(await liveRunnerWork(db, item, now)))
      say(`no owner: no current job and no live runner work (${live.map((j) => j.queue)})`);
    if (item.state === "merge_queue") {
      if (item.acceptedHead === null) say("in the merge queue without an accepted head");
      else {
        const verdict =
          (await closeoutPolicyDigests(db, item.id, item.acceptedHead))?.decision ?? null;
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
