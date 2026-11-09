import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { JOB_KIND, delegationHasOpenWork, type WorkItemState } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { jsonItemId } from "./jobs";
import { jsonField, jsonText, jsonValue } from "./json-text";
import { ciWaitingSql, workHelperSql } from "./runner-capacity";
import { runnerLeaseCutoff } from "./runner-lease";

export type SchedulerItem = {
  id: string;
  delegationId: string;
  issueId: string;
  identifier: string | null;
  position: number;
  absent: number;
  state: WorkItemState;
  version: number;
  createdAt: number;
  cancelRequested: number;
  liveRun: number;
  liveJob: number;
  placed: number;
  placing: number;
  setupHeld: number;
  workspaceId: string | null;
  sessionId: string | null;
  priority: number | null;
  owner: string | null;
  repo: string | null;
  turn: string;
  mergePosition: number | null;
  mergeAt: number | null;
};

type ItemScheduling = {
  itemId: string;
  projectId: string | null;
  projectKnown: number;
  priority: number;
  paths: string | null;
  projectLeadId: string | null;
  replaceLead: number;
};

const num = (fragment: SQL) => sql<number>`${fragment}`.mapWith(Number);

export function* saveItemSchedulingSteps(q: Q, row: ItemScheduling) {
  const { workItemScheduling } = q.t;
  const paths = row.paths === null ? null : jsonValue(q, JSON.parse(row.paths));
  yield* q.exec(
    q.orm
      .insert(workItemScheduling)
      .values({
        itemId: row.itemId,
        projectId: row.projectId,
        projectKnown: row.projectKnown,
        priority: row.priority,
        paths,
        projectLeadId: row.projectLeadId,
      })
      .onConflictDoUpdate({
        target: workItemScheduling.itemId,
        set: {
          projectId: sql`excluded.project_id`,
          projectKnown: sql`excluded.project_known`,
          priority: sql`excluded.priority`,
          paths: sql`excluded.paths`,
          ...(row.replaceLead ? { projectLeadId: sql`excluded.project_lead_id` } : {}),
        },
      }),
  );
}

export function saveItemScheduling(db: Database, row: ItemScheduling): void {
  settled(sqliteDb(db).run((q) => saveItemSchedulingSteps(q, row)));
}

export function* schedulingProjectLeadSteps(q: Q, itemId: string) {
  const { workItemScheduling } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ lead: workItemScheduling.projectLeadId })
      .from(workItemScheduling)
      .where(eq(workItemScheduling.itemId, itemId)),
  );
  return row?.lead ?? null;
}

export function schedulingProjectLead(db: Database, itemId: string): string | null {
  return settled(sqliteDb(db).run((q) => schedulingProjectLeadSteps(q, itemId)));
}

/** The people who lead a Linear project anywhere in the delegation, by `workspace_user` id. */
export function* delegationProjectLeadIdsSteps(q: Q, delegationId: string) {
  const { workItem: i, workItemScheduling: c, workspaceUser: u } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ id: u.id })
      .from(i)
      .innerJoin(c, eq(c.itemId, i.id))
      .innerJoin(u, eq(u.linearUserId, c.projectLeadId))
      .where(eq(i.delegationId, delegationId))
      .orderBy(asc(u.id)),
  );
  return rows.map((row) => row.id);
}

export function delegationProjectLeadIds(db: Database, delegationId: string): string[] {
  return settled(sqliteDb(db).run((q) => delegationProjectLeadIdsSteps(q, delegationId)));
}

export function* itemPathHintsSteps(q: Q, itemId: string) {
  const { workItem, workItemScheduling } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        paths: jsonText(q, workItemScheduling.paths) as SQL<string | null>,
        brief: jsonText(q, workItem.brief) as SQL<string | null>,
      })
      .from(workItem)
      .leftJoin(workItemScheduling, eq(workItemScheduling.itemId, workItem.id))
      .where(eq(workItem.id, itemId)),
  );
  return row ?? null;
}

export function itemPathHints(db: Database, itemId: string) {
  return settled(sqliteDb(db).run((q) => itemPathHintsSteps(q, itemId)));
}

export function* listSchedulerAdmissionsSteps(q: Q) {
  const { job, schedulerAdmission } = q.t;
  return yield* q.all(
    q.orm
      .select({
        itemId: schedulerAdmission.itemId,
        jobId: schedulerAdmission.jobId,
        repositoryKey: schedulerAdmission.repositoryKey,
        sessionId: schedulerAdmission.sessionId,
        status: job.status,
        lockedUntil: job.lockedUntil,
        runnerId: jsonField(q, job.payload, "admissionRunnerId"),
      })
      .from(schedulerAdmission)
      .innerJoin(job, eq(job.id, schedulerAdmission.jobId)),
  );
}

export function listSchedulerAdmissions(db: Database) {
  return settled(sqliteDb(db).run(listSchedulerAdmissionsSteps));
}

export function* dropSchedulerAdmissionSteps(q: Q, itemId: string) {
  const { schedulerAdmission } = q.t;
  yield* q.exec(q.orm.delete(schedulerAdmission).where(eq(schedulerAdmission.itemId, itemId)));
}

export function dropSchedulerAdmission(db: Database, itemId: string): void {
  settled(sqliteDb(db).run((q) => dropSchedulerAdmissionSteps(q, itemId)));
}

type SchedulerAdmission = {
  itemId: string;
  jobId: number;
  repositoryKey: string;
  sessionId: string | null;
  now: number;
  runnerId?: string;
};

export function* saveSchedulerAdmissionSteps(q: Q, row: SchedulerAdmission, orIgnore = false) {
  const insert = q.orm.insert(q.t.schedulerAdmission).values({
    itemId: row.itemId,
    jobId: row.jobId,
    projectKey: "*",
    repositoryKey: row.repositoryKey,
    sessionId: row.sessionId,
    paths: jsonValue(q, []),
    hot: 0,
    createdAt: row.now,
  });
  yield* q.exec(orIgnore ? insert.onConflictDoNothing() : insert);
  if (row.runnerId) {
    const job = q.t.job;
    const saved = yield* q.one(
      q.orm
        .select({ payload: jsonText(q, job.payload) })
        .from(job)
        .where(eq(job.id, row.jobId)),
    );
    if (saved)
      yield* q.exec(
        q.orm
          .update(job)
          .set({
            payload: jsonValue(q, {
              ...JSON.parse(saved.payload),
              admissionRunnerId: row.runnerId,
            }),
          })
          .where(eq(job.id, row.jobId)),
      );
  }
}

export function saveSchedulerAdmission(
  db: Database,
  row: SchedulerAdmission,
  orIgnore = false,
): void {
  settled(sqliteDb(db).run((q) => saveSchedulerAdmissionSteps(q, row, orIgnore)));
}

export function* schedulerItemsSteps(q: Q, now: number) {
  const i = alias(q.t.workItem, "i");
  const e = alias(q.t.mergeQueueEntry, "e");
  const s = alias(q.t.linearSession, "s");
  const w = alias(q.t.workspace, "w");
  const c = alias(q.t.workItemScheduling, "c");
  const r = alias(q.t.workItemRepository, "r");
  const heldItem = jsonItemId(q, sql.raw("held.payload"));
  const startItem = jsonItemId(q, sql.raw("start.payload"));
  const rows = yield* q.all(
    q.orm
      .select({
        id: i.id,
        delegationId: i.delegationId,
        issueId: i.linearIssueId,
        identifier: i.linearIdentifier,
        position: i.position,
        absent: num(
          sql`EXISTS(SELECT 1 FROM work_item_specification f WHERE f.item_id=i.id AND f.present=0)`,
        ),
        state: i.state,
        version: i.version,
        createdAt: i.createdAt,
        cancelRequested: i.cancelRequested,
        liveRun: num(
          sql`EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning'))`,
        ),
        liveJob: num(sql`EXISTS(SELECT 1 FROM job held WHERE ${heldItem}=i.id
          AND held.status='running' AND (held.locked_until IS NULL OR held.locked_until>${now})
          AND (held.queue IN ('item.start','run.resume','run.reverify','github.merge')
            OR held.queue LIKE 'github.merge.%'))`),
        placed:
          num(sql`EXISTS(SELECT 1 FROM run p JOIN runner_work w ON w.run_id=p.id WHERE p.item_id=i.id
          AND ((w.ended_at IS NULL AND w.lease_until>${runnerLeaseCutoff(now)}) OR p.status IN ('active','provisioning')))`),
        placing: num(sql`EXISTS(SELECT 1 FROM job start WHERE ${startItem}=i.id
          AND start.status='running' AND (start.locked_until IS NULL OR start.locked_until>${now})
          AND start.queue IN (${sql.raw(`'${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}'`)}))
          AND NOT EXISTS(SELECT 1 FROM runner_reservation v WHERE v.run_id=i.current_run_id AND v.expires_at>${now})`),
        setupHeld: num(sql`EXISTS(SELECT 1 FROM runner_setup_hold h WHERE h.item_id=i.id)`),
        workspaceId: w.id,
        sessionId: s.sessionId,
        priority: c.priority,
        owner: r.owner,
        repo: r.repo,
        turn: sql<string>`COALESCE('user:'||i.owner_user_id,'')`,
        mergePosition:
          num(sql`CASE WHEN e.item_id IS NULL THEN NULL ELSE (SELECT count(*) FROM merge_queue_entry o
          JOIN work_item ow ON ow.id=o.item_id WHERE o.repository=e.repository
          AND ow.state IN ('merge_queue','verifying') AND ow.cancel_requested=0
          AND (o.ready_at<e.ready_at OR (o.ready_at=e.ready_at AND o.item_id<=e.item_id))) END`),
        mergeAt:
          num(sql`COALESCE(e.ready_at,CASE WHEN i.state='queued' THEN (SELECT ev.at FROM work_item_event ev
          WHERE ev.id=(SELECT MAX(last.id) FROM work_item_event last WHERE last.item_id=i.id)
          AND ev.kind='restart' AND (ev.from_state='merge_queue' OR (ev.from_state='verifying'
            AND (SELECT p.from_state FROM work_item_event p WHERE p.item_id=i.id AND p.id<ev.id
              AND p.to_state='verifying' AND p.from_state<>'verifying' ORDER BY p.id DESC LIMIT 1)='merge_queue'))) END)`),
      })
      .from(i)
      .leftJoin(e, and(eq(e.itemId, i.id), inArray(i.state, ["merge_queue", "verifying"])))
      .leftJoin(s, eq(s.sessionId, i.sessionKey))
      .leftJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .leftJoin(c, eq(c.itemId, i.id))
      .leftJoin(r, eq(r.itemId, i.id))
      .where(
        sql`${sql.raw(delegationHasOpenWork("i.delegation_id"))} OR i.state IN ('running','verifying','recovering','awaiting_input','paused','merge_queue')
        OR EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning'))`,
      ),
  );
  return rows as SchedulerItem[];
}

export function schedulerItems(db: Database, now: number): SchedulerItem[] {
  return settled(sqliteDb(db).run((q) => schedulerItemsSteps(q, now)));
}

export function* runnerTaskSlotsSteps(q: Q, now: number, seenAfter: number) {
  const r = alias(q.t.runner, "r");
  const least = q.dialect === "sqlite" ? sql.raw("MIN") : sql.raw("LEAST");
  return yield* q.all(
    q.orm
      .select({
        id: r.id,
        capacity: num(
          sql`COALESCE((SELECT ${least}(c.capacity,COALESCE(c.desired,16)) FROM runner_capacity c WHERE c.runner_id=r.id),1)`,
        ),
        used: num(sql`(SELECT count(*) FROM runner_work w WHERE w.runner_id=r.id AND ((w.ended_at IS NULL AND w.lease_until>${runnerLeaseCutoff(now)}) OR EXISTS(SELECT 1 FROM run held WHERE held.id=w.run_id AND held.status IN ('active','provisioning') AND NOT ${ciWaitingSql(q, "held")}))) +
          (SELECT count(*) FROM runner_helper x WHERE x.runner_id=r.id AND x.ended_at IS NULL AND x.expires_at>${now}
            AND ${workHelperSql(q, "x")}) +
          (SELECT count(*) FROM runner_reservation v WHERE v.runner_id=r.id AND v.expires_at>${now}
            AND NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.run_id=v.run_id AND w.runner_id=v.runner_id))`),
      })
      .from(r)
      .where(and(eq(r.status, "active"), isNull(r.revokedAt), gt(r.lastSeenAt, seenAfter))),
  );
}

export function runnerTaskSlots(db: Database, now: number, seenAfter: number) {
  return settled(sqliteDb(db).run((q) => runnerTaskSlotsSteps(q, now, seenAfter)));
}

export function* pendingRunnerWaitsSteps(q: Q, seenAfter: number) {
  const i = alias(q.t.workItem, "i");
  const j = alias(q.t.job, "j");
  const w = alias(q.t.runnerWork, "w");
  const r = alias(q.t.runner, "r");
  return yield* q.all(
    q.orm
      .select({
        itemId: i.id,
        jobId: j.id,
        runnerId: w.runnerId,
        online: num(sql`r.id IS NOT NULL`),
        merging: num(sql`EXISTS(SELECT 1 FROM merge_queue_entry e WHERE e.item_id=i.id)`),
        payload: jsonText(q, j.payload),
      })
      .from(i)
      .innerJoin(
        j,
        sql`j.id=(SELECT q.id FROM job q WHERE q.status='pending'
          AND q.queue IN (${sql.raw(`'${JOB_KIND.resume}','${JOB_KIND.reverify}'`)})
          AND ${jsonItemId(q, sql.raw("q.payload"))}=i.id ORDER BY q.id DESC LIMIT 1)`,
      )
      .leftJoin(w, eq(w.runId, i.currentRunId))
      .leftJoin(
        r,
        and(
          eq(r.id, w.runnerId),
          eq(r.status, "active"),
          isNull(r.revokedAt),
          gt(r.lastSeenAt, seenAfter),
        ),
      )
      .where(
        and(inArray(i.state, ["recovering", "verifying", "merge_queue"]), eq(i.cancelRequested, 0)),
      ),
  );
}

export function pendingRunnerWaits(db: Database, seenAfter: number) {
  return settled(sqliteDb(db).run((q) => pendingRunnerWaitsSteps(q, seenAfter)));
}

export function* schedulerRunnerSlotsSteps(q: Q, now: number) {
  const { job, schedulerAdmission: admission, workItem: item } = q.t;
  const runnerId = jsonField(q, job.payload, "admissionRunnerId");
  return yield* q.all(
    q.orm
      .select({ itemId: item.id, runnerId })
      .from(admission)
      .innerJoin(job, eq(job.id, admission.jobId))
      .innerJoin(item, eq(item.id, admission.itemId))
      .where(
        and(
          isNotNull(runnerId),
          eq(item.cancelRequested, 0),
          inArray(item.state, ["queued", "running", "recovering", "verifying"]),
          or(
            eq(job.status, "pending"),
            and(eq(job.status, "running"), or(isNull(job.lockedUntil), gt(job.lockedUntil, now))),
          ),
          sql`(${item.state}='queued' OR NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.run_id=${item.currentRunId} AND w.ended_at IS NULL AND w.lease_until>${runnerLeaseCutoff(now)}))`,
          sql`NOT EXISTS(SELECT 1 FROM runner_reservation v WHERE v.run_id=${item.currentRunId} AND v.expires_at>${now})`,
        ),
      ),
  );
}

export function schedulerRunnerSlots(db: Database, now: number) {
  return settled(sqliteDb(db).run((q) => schedulerRunnerSlotsSteps(q, now)));
}

/** Replace or abandon a scheduler choice; physical reservations keep their own lifecycle. */
export function setSchedulerRunnerSlot(
  db: Database,
  itemId: string,
  runnerId: string | null,
): void {
  settled(
    sqliteDb(db).run(function* (q: Q) {
      const { job, schedulerAdmission: admission } = q.t;
      const row = yield* q.one(
        q.orm
          .select({ id: job.id, payload: jsonText(q, job.payload) })
          .from(admission)
          .innerJoin(job, eq(job.id, admission.jobId))
          .where(eq(admission.itemId, itemId)),
      );
      if (!row) return;
      const { admissionRunnerId: _choice, ...payload } = JSON.parse(row.payload);
      yield* q.exec(
        q.orm
          .update(job)
          .set({
            payload: jsonValue(q, {
              ...payload,
              ...(runnerId ? { admissionRunnerId: runnerId } : {}),
            }),
          })
          .where(eq(job.id, row.id)),
      );
    }),
  );
}
