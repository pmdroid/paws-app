import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { JOB_KIND, delegationHasOpenWork, type WorkItemState } from "../core";
import { orm } from "./orm";
import { CI_WAITING, WORK_HELPER } from "./runner-capacity";
import { runnerLeaseCutoff } from "./runner-lease";
import { job, schedulerAdmission, workItemScheduling } from "./schema";
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

export function saveItemScheduling(
  db: Database,
  row: {
    itemId: string;
    projectId: string | null;
    projectKnown: number;
    priority: number;
    paths: string | null;
    projectLeadId: string | null;
    replaceLead: number;
  },
): void {
  orm(db)
    .insert(workItemScheduling)
    .values({
      itemId: row.itemId,
      projectId: row.projectId,
      projectKnown: row.projectKnown,
      priority: row.priority,
      paths: row.paths,
      projectLeadId: row.projectLeadId,
    })
    .onConflictDoUpdate({
      target: workItemScheduling.itemId,
      set: {
        projectId: sql`excluded.project_id`,
        projectKnown: sql`excluded.project_known`,
        priority: sql`excluded.priority`,
        paths: sql`excluded.paths`,
        projectLeadId: sql`CASE WHEN ${row.replaceLead} THEN excluded.project_lead_id ELSE work_item_scheduling.project_lead_id END`,
      },
    })
    .run();
}

export function schedulingProjectLead(db: Database, itemId: string): string | null {
  return (
    orm(db)
      .select({ lead: workItemScheduling.projectLeadId })
      .from(workItemScheduling)
      .where(eq(workItemScheduling.itemId, itemId))
      .get()?.lead ?? null
  );
}

export function listSchedulerAdmissions(db: Database): {
  itemId: string;
  jobId: number;
  repositoryKey: string;
  sessionId: string | null;
  status: string;
  lockedUntil: number | null;
}[] {
  return orm(db)
    .select({
      itemId: schedulerAdmission.itemId,
      jobId: schedulerAdmission.jobId,
      repositoryKey: schedulerAdmission.repositoryKey,
      sessionId: schedulerAdmission.sessionId,
      status: job.status,
      lockedUntil: job.lockedUntil,
    })
    .from(schedulerAdmission)
    .innerJoin(job, eq(job.id, schedulerAdmission.jobId))
    .all();
}

export function dropSchedulerAdmission(db: Database, itemId: string): void {
  orm(db).delete(schedulerAdmission).where(eq(schedulerAdmission.itemId, itemId)).run();
}

export function saveSchedulerAdmission(
  db: Database,
  row: {
    itemId: string;
    jobId: number;
    repositoryKey: string;
    sessionId: string | null;
    now: number;
  },
  orIgnore = false,
): void {
  const insert = orm(db).insert(schedulerAdmission).values({
    itemId: row.itemId,
    jobId: row.jobId,
    projectKey: "*",
    repositoryKey: row.repositoryKey,
    sessionId: row.sessionId,
    paths: "[]",
    hot: 0,
    createdAt: row.now,
  });
  (orIgnore ? insert.onConflictDoNothing() : insert).run();
}

export function schedulerItems(db: Database, now: number): SchedulerItem[] {
  return orm(db)
    .all<SchedulerItem>(sql`SELECT i.id,i.delegation_id AS delegationId,i.linear_issue_id AS issueId,
    i.linear_identifier AS identifier,i.position,
    EXISTS(SELECT 1 FROM work_item_specification f WHERE f.item_id=i.id AND f.present=0) AS absent,
    i.state,i.version,i.created_at AS createdAt,i.cancel_requested AS cancelRequested,
    EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning')) AS liveRun,
    EXISTS(SELECT 1 FROM job held WHERE json_extract(held.payload,'$.itemId')=i.id
      AND held.status='running' AND (held.locked_until IS NULL OR held.locked_until>${now})
      AND (held.queue IN ('item.start','run.resume','run.reverify','github.merge')
        OR held.queue LIKE 'github.merge.%')) AS liveJob,
    EXISTS(SELECT 1 FROM run p JOIN runner_work w ON w.run_id=p.id WHERE p.item_id=i.id
      AND ((w.ended_at IS NULL AND w.lease_until>${runnerLeaseCutoff(now)}) OR p.status IN ('active','provisioning'))) AS placed,
    EXISTS(SELECT 1 FROM job start WHERE json_extract(start.payload,'$.itemId')=i.id
      AND start.status='running' AND (start.locked_until IS NULL OR start.locked_until>${now})
      AND start.queue IN (${sql.raw(`'${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}'`)}))
      AND NOT EXISTS(SELECT 1 FROM runner_reservation v WHERE v.run_id=i.current_run_id AND v.expires_at>${now}) AS placing,
    EXISTS(SELECT 1 FROM runner_setup_hold h WHERE h.item_id=i.id) AS setupHeld,
    w.id AS workspaceId,s.session_id AS sessionId,c.priority,r.owner,r.repo,
    COALESCE('user:'||i.owner_user_id,'') AS turn,
    CASE WHEN e.item_id IS NULL THEN NULL ELSE (SELECT count(*) FROM merge_queue_entry o
      JOIN work_item ow ON ow.id=o.item_id WHERE o.repository=e.repository
      AND ow.state IN ('merge_queue','verifying') AND ow.cancel_requested=0
      AND (o.ready_at<e.ready_at OR (o.ready_at=e.ready_at AND o.item_id<=e.item_id))) END AS mergePosition,
    COALESCE(e.ready_at,CASE WHEN i.state='queued' THEN (SELECT ev.at FROM work_item_event ev
      WHERE ev.id=(SELECT MAX(last.id) FROM work_item_event last WHERE last.item_id=i.id)
      AND ev.kind='restart' AND (ev.from_state='merge_queue' OR (ev.from_state='verifying'
        AND (SELECT p.from_state FROM work_item_event p WHERE p.item_id=i.id AND p.id<ev.id
          AND p.to_state='verifying' AND p.from_state<>'verifying' ORDER BY p.id DESC LIMIT 1)='merge_queue'))) END) AS mergeAt
    FROM work_item i
    LEFT JOIN merge_queue_entry e ON e.item_id=i.id AND i.state IN ('merge_queue','verifying')
    LEFT JOIN linear_session s ON s.session_id=i.session_key
    LEFT JOIN workspace w ON w.linear_organization_id=s.organization_id
    LEFT JOIN work_item_scheduling c ON c.item_id=i.id
    LEFT JOIN work_item_repository r ON r.item_id=i.id
    WHERE ${sql.raw(delegationHasOpenWork("i.delegation_id"))} OR i.state IN ('running','verifying','recovering','awaiting_input','paused','merge_queue')
    OR EXISTS(SELECT 1 FROM run live WHERE live.item_id=i.id AND live.status IN ('active','provisioning'))`);
}
export function runnerTaskSlots(
  db: Database,
  now: number,
  seenAfter: number,
): { id: string; capacity: number; used: number }[] {
  return orm(db).all<{ id: string; capacity: number; used: number }>(
    sql`SELECT r.id,COALESCE((SELECT MIN(c.capacity,COALESCE(c.desired,16)) FROM runner_capacity c WHERE c.runner_id=r.id),1) AS capacity,
       (SELECT count(*) FROM runner_work w WHERE w.runner_id=r.id AND ((w.ended_at IS NULL AND w.lease_until>${runnerLeaseCutoff(now)}) OR EXISTS(SELECT 1 FROM run held WHERE held.id=w.run_id AND held.status IN ('active','provisioning') AND NOT ${sql.raw(CI_WAITING("held"))}))) +
       (SELECT count(*) FROM runner_helper x WHERE x.runner_id=r.id AND x.ended_at IS NULL AND x.expires_at>${now}
         AND ${sql.raw(WORK_HELPER("x"))}) +
       (SELECT count(*) FROM runner_reservation v WHERE v.runner_id=r.id AND v.expires_at>${now}
         AND NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.run_id=v.run_id AND w.runner_id=v.runner_id)) AS used
       FROM runner r WHERE r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>${seenAfter}`,
  );
}
export function pendingRunnerWaits(
  db: Database,
  seenAfter: number,
): {
  itemId: string;
  jobId: number;
  runnerId: string | null;
  online: number;
  merging: number;
  payload: string;
}[] {
  return orm(db).all(
    sql`SELECT i.id AS itemId,j.id AS jobId,w.runner_id AS runnerId,r.id IS NOT NULL AS online,
       EXISTS(SELECT 1 FROM merge_queue_entry e WHERE e.item_id=i.id) AS merging,j.payload
       FROM work_item i
       JOIN job j ON j.id=(SELECT q.id FROM job q WHERE q.status='pending'
         AND q.queue IN (${sql.raw(`'${JOB_KIND.resume}','${JOB_KIND.reverify}'`)})
         AND json_extract(q.payload,'$.itemId')=i.id ORDER BY q.id DESC LIMIT 1)
       LEFT JOIN runner_work w ON w.run_id=i.current_run_id
       LEFT JOIN runner r ON r.id=w.runner_id
         AND r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>${seenAfter}
       WHERE i.state IN ('recovering','verifying','merge_queue') AND i.cancel_requested=0`,
  );
}
