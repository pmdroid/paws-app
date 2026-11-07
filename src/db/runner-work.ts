import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { orm } from "./orm";
import {
  run,
  runner,
  runnerCommand,
  runnerEvent,
  runnerHostStatus,
  runnerResult,
  runnerWork,
} from "./schema";

export function itemOpenRunnerWorkRuns(db: Database, itemId: string): { runId: string }[] {
  return orm(db)
    .select({ runId: runnerWork.runId })
    .from(runnerWork)
    .innerJoin(run, eq(run.id, runnerWork.runId))
    .where(and(eq(run.itemId, itemId), isNull(runnerWork.endedAt)))
    .all();
}

export function itemOpenRunnerWork(
  db: Database,
  itemId: string,
): { runId: string; runnerId: string; workspaceId: string; generation: number } | null {
  return (
    orm(db)
      .select({
        runId: runnerWork.runId,
        runnerId: runnerWork.runnerId,
        workspaceId: runnerWork.workspaceId,
        generation: runnerWork.generation,
      })
      .from(runnerWork)
      .innerJoin(run, eq(run.id, runnerWork.runId))
      .where(and(eq(run.itemId, itemId), isNull(runnerWork.endedAt)))
      .get() ?? null
  );
}

export function itemRunnerCancelWork(
  db: Database,
  itemId: string,
): {
  runId: string;
  runnerId: string;
  workspaceId: string;
  generation: number;
  leaseUntil: number;
  requested: number;
}[] {
  return orm(db).all(
    sql`SELECT w.run_id AS runId,w.runner_id AS runnerId,w.workspace_id AS workspaceId,
     w.generation,w.lease_until AS leaseUntil,(w.ended_at IS NULL OR EXISTS (
       SELECT 1 FROM runner_command c WHERE c.run_id=w.run_id AND c.generation=w.generation
       AND c.runner_id=w.runner_id AND c.kind='cancel' AND c.acknowledged_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id
         AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL))) AS requested
     FROM runner_work w JOIN run r ON r.id=w.run_id WHERE r.item_id=${itemId}`,
  );
}

export function pendingRunnerCancel(
  db: Database,
  input: { runId: string; runnerId: string; generation: number; now: number },
): { id: string; expiresAt: number } | null {
  return (
    orm(db)
      .select({ id: runnerCommand.id, expiresAt: runnerCommand.expiresAt })
      .from(runnerCommand)
      .where(
        and(
          eq(runnerCommand.runId, input.runId),
          eq(runnerCommand.runnerId, input.runnerId),
          eq(runnerCommand.generation, input.generation),
          eq(runnerCommand.kind, "cancel"),
          isNull(runnerCommand.acknowledgedAt),
          gt(runnerCommand.expiresAt, input.now),
        ),
      )
      .orderBy(desc(runnerCommand.ordinal))
      .limit(1)
      .get() ?? null
  );
}

export function itemRunnerWorkReports(
  db: Database,
  itemId: string,
): {
  endedAt: number | null;
  confirmedAt: number | null;
  reportedAt: number | null;
  acknowledgedAt: number | null;
  expiresAt: number | null;
}[] {
  return orm(db)
    .select({
      endedAt: runnerWork.endedAt,
      confirmedAt: runnerWork.confirmedAt,
      reportedAt: runner.liveReportedAt,
      acknowledgedAt: runnerCommand.acknowledgedAt,
      expiresAt: runnerCommand.expiresAt,
    })
    .from(runnerWork)
    .innerJoin(run, eq(run.id, runnerWork.runId))
    .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
    .leftJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
    .where(eq(run.itemId, itemId))
    .all();
}

export function openRunnerWorkCommand(
  db: Database,
  runId: string,
): {
  runnerId: string;
  workspaceId: string;
  generation: number;
  envelope: string;
  lastSeen: number | null;
  version: string | null;
} | null {
  return (
    orm(db)
      .select({
        runnerId: runnerWork.runnerId,
        workspaceId: runnerWork.workspaceId,
        generation: runnerWork.generation,
        envelope: runnerCommand.envelope,
        lastSeen: runner.lastSeenAt,
        version: runnerHostStatus.runnerVersion,
      })
      .from(runnerWork)
      .innerJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
      .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runnerWork.runnerId))
      .where(and(eq(runnerWork.runId, runId), isNull(runnerWork.endedAt)))
      .get() ?? null
  );
}

export function runnerHandoverSent(db: Database, runId: string, generation: number): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(runnerCommand)
      .where(
        and(
          eq(runnerCommand.runId, runId),
          eq(runnerCommand.generation, generation),
          eq(runnerCommand.kind, "handover"),
        ),
      )
      .get() !== undefined
  );
}

export function runnerWorkEnded(db: Database, runId: string, generation: number): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(
          eq(runnerWork.runId, runId),
          eq(runnerWork.generation, generation),
          isNotNull(runnerWork.endedAt),
        ),
      )
      .get() !== undefined
  );
}

export function lastRunnerEventSequence(db: Database, runId: string, generation: number): number {
  return orm(db)
    .select({ sequence: sql<number>`COALESCE(MAX(${runnerEvent.sequence}),0)` })
    .from(runnerEvent)
    .where(and(eq(runnerEvent.runId, runId), eq(runnerEvent.generation, generation)))
    .get()!.sequence;
}

export function runnerEventsAfter(
  db: Database,
  input: { runId: string; generation: number; after: number; types: readonly string[] },
): {
  runId: string;
  generation: number;
  sequence: number;
  payload: string;
  keyId: string | null;
  payloadSha256: string | null;
}[] {
  return orm(db)
    .select({
      runId: runnerEvent.runId,
      generation: runnerEvent.generation,
      sequence: runnerEvent.sequence,
      payload: runnerEvent.payload,
      keyId: runnerEvent.keyId,
      payloadSha256: runnerEvent.payloadSha256,
    })
    .from(runnerEvent)
    .where(
      and(
        eq(runnerEvent.runId, input.runId),
        eq(runnerEvent.generation, input.generation),
        gt(runnerEvent.sequence, input.after),
        or(
          inArray(runnerEvent.type, [...input.types]),
          and(isNull(runnerEvent.type), isNull(runnerEvent.keyId)),
        ),
      ),
    )
    .orderBy(runnerEvent.sequence)
    .all();
}

export function runnerResultPayload(
  db: Database,
  runId: string,
  generation: number,
): string | null {
  return (
    orm(db)
      .select({ payload: runnerResult.payload })
      .from(runnerResult)
      .where(and(eq(runnerResult.runId, runId), eq(runnerResult.generation, generation)))
      .get()?.payload ?? null
  );
}

export function runnerWorkActive(db: Database, runId: string): boolean | null {
  const row = orm(db).all<{ agent: number }>(
    sql`SELECT EXISTS(SELECT 1 FROM runner_event e WHERE e.run_id=w.run_id
     AND e.generation=w.generation AND e.type='activity') AS agent
     FROM runner_work w WHERE w.run_id=${runId}`,
  )[0];
  return row === undefined ? null : row.agent === 1;
}
