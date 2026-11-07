import type { Database } from "bun:sqlite";
import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { changes, orm } from "./orm";
import { retroDispatch, retroGeneration as generation } from "./schema";
import { immediate } from "./tx";
import { ulid } from "./ulid";

export const newRetroCommandId = (now: number): string => ulid(now);

export type RetroDispatchRelease = "result" | "not_started" | "teardown";

export type RetroGenerationDiagnostic =
  | "no_runner"
  | "capacity_wait"
  | "quota_cooldown"
  | "dispatched"
  | "active"
  | "unknown_outcome"
  | "retry_backoff"
  | "failed"
  | "ready";

export const RETRO_WAIT_DIAGNOSTICS: readonly RetroGenerationDiagnostic[] = [
  "no_runner",
  "capacity_wait",
  "quota_cooldown",
];

export type RetroDispatch = {
  commandId: string;
  retroId: string;
  attempt: number;
  workspaceId: string;
  runnerId: string;
  runnerFence: number;
  command: unknown;
  envelope: unknown;
  deliveries: number;
  createdAt: number;
  issuedAt: number;
  expiresAt: number;
  fetchedAt: number | null;
  acknowledgedAt: number | null;
  cancelRequestedAt: number | null;
  result: unknown;
  resultAt: number | null;
  releasedAt: number | null;
  releaseReason: RetroDispatchRelease | null;
  settledAt: number | null;
};

export type RetroGenerationRow = {
  retroId: string;
  diagnostic: RetroGenerationDiagnostic;
  detail: string;
  since: number;
  until: number | null;
  waitMs: number;
  activeMs: number;
  updatedAt: number;
};

type DispatchRow = typeof retroDispatch.$inferSelect;

function fromRow(row: DispatchRow): RetroDispatch {
  return {
    ...row,
    command: JSON.parse(row.command),
    envelope: JSON.parse(row.envelope),
    result: row.result === null ? null : JSON.parse(row.result),
    releaseReason: row.releaseReason as RetroDispatchRelease | null,
  };
}

const unreleased = isNull(retroDispatch.releasedAt);
const unfinished = or(unreleased, isNull(retroDispatch.settledAt));

export function recordRetroDispatch(
  db: Database,
  input: {
    commandId: string;
    retroId: string;
    attempt: number;
    workspaceId: string;
    runnerId: string;
    runnerFence: number;
    command: unknown;
    envelope: unknown;
    issuedAt: number;
    expiresAt: number;
    now: number;
  },
): RetroDispatch {
  orm(db)
    .insert(retroDispatch)
    .values({
      commandId: input.commandId,
      retroId: input.retroId,
      attempt: input.attempt,
      workspaceId: input.workspaceId,
      runnerId: input.runnerId,
      runnerFence: input.runnerFence,
      command: JSON.stringify(input.command),
      envelope: JSON.stringify(input.envelope),
      createdAt: input.now,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    })
    .run();
  return getRetroDispatch(db, input.commandId)!;
}

export function getRetroDispatch(db: Database, commandId: string): RetroDispatch | null {
  const row = orm(db)
    .select()
    .from(retroDispatch)
    .where(eq(retroDispatch.commandId, commandId))
    .get();
  return row === undefined ? null : fromRow(row);
}

export function listRetroDispatches(db: Database, retroId: string): RetroDispatch[] {
  return orm(db)
    .select()
    .from(retroDispatch)
    .where(eq(retroDispatch.retroId, retroId))
    .orderBy(retroDispatch.attempt)
    .all()
    .map(fromRow);
}

export function openRetroDispatch(db: Database, retroId: string): RetroDispatch | null {
  const row = orm(db)
    .select()
    .from(retroDispatch)
    .where(and(eq(retroDispatch.retroId, retroId), unfinished))
    .orderBy(desc(retroDispatch.attempt))
    .limit(1)
    .get();
  return row === undefined ? null : fromRow(row);
}

export function unfinishedRetroDispatches(db: Database): RetroDispatch[] {
  return orm(db)
    .select()
    .from(retroDispatch)
    .where(unfinished)
    .orderBy(retroDispatch.createdAt)
    .all()
    .map(fromRow);
}

export function deliverableRetroDispatches(db: Database, runnerId: string): RetroDispatch[] {
  return orm(db)
    .select()
    .from(retroDispatch)
    .where(
      and(
        eq(retroDispatch.runnerId, runnerId),
        unreleased,
        isNull(retroDispatch.acknowledgedAt),
        isNull(retroDispatch.cancelRequestedAt),
      ),
    )
    .orderBy(retroDispatch.createdAt)
    .limit(16)
    .all()
    .map(fromRow);
}

export function retroSlotsHeld(db: Database, runnerId: string): number {
  return orm(db)
    .select({ held: count() })
    .from(retroDispatch)
    .where(and(eq(retroDispatch.runnerId, runnerId), unreleased))
    .get()!.held;
}

export function retroDispatchesNotStarted(db: Database, retroId: string): number {
  return orm(db)
    .select({ count: count() })
    .from(retroDispatch)
    .where(and(eq(retroDispatch.retroId, retroId), eq(retroDispatch.releaseReason, "not_started")))
    .get()!.count;
}

export function markRetroDispatchFetched(db: Database, commandId: string, now: number): void {
  orm(db)
    .update(retroDispatch)
    .set({ fetchedAt: sql`COALESCE(${retroDispatch.fetchedAt}, ${now})` })
    .where(and(eq(retroDispatch.commandId, commandId), unreleased))
    .run();
}

export function resignRetroDispatch(
  db: Database,
  input: { commandId: string; envelope: unknown; issuedAt: number; expiresAt: number },
): boolean {
  return (
    changes(
      orm(db)
        .update(retroDispatch)
        .set({
          envelope: JSON.stringify(input.envelope),
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
          deliveries: sql`${retroDispatch.deliveries} + 1`,
        })
        .where(
          and(
            eq(retroDispatch.commandId, input.commandId),
            unreleased,
            isNull(retroDispatch.fetchedAt),
            isNull(retroDispatch.acknowledgedAt),
          ),
        ),
    ) === 1
  );
}

export function acknowledgeRetroDispatch(db: Database, commandId: string, now: number): boolean {
  return (
    changes(
      orm(db)
        .update(retroDispatch)
        .set({
          acknowledgedAt: sql`COALESCE(${retroDispatch.acknowledgedAt}, ${now})`,
          fetchedAt: sql`COALESCE(${retroDispatch.fetchedAt}, ${now})`,
        })
        .where(
          and(
            eq(retroDispatch.commandId, commandId),
            unreleased,
            isNull(retroDispatch.cancelRequestedAt),
          ),
        ),
    ) === 1
  );
}

export function requestRetroDispatchCancel(db: Database, commandId: string, now: number): void {
  orm(db)
    .update(retroDispatch)
    .set({ cancelRequestedAt: sql`COALESCE(${retroDispatch.cancelRequestedAt}, ${now})` })
    .where(and(eq(retroDispatch.commandId, commandId), unreleased))
    .run();
}

export function recordRetroDispatchResult(
  db: Database,
  input: { commandId: string; result: unknown; now: number },
): "recorded" | "duplicate" | "conflict" | "released" {
  return immediate(db, () => {
    const dispatch = getRetroDispatch(db, input.commandId);
    if (dispatch === null) return "released";
    const text = JSON.stringify(input.result);
    if (dispatch.result !== null)
      return JSON.stringify(dispatch.result) === text ? "duplicate" : "conflict";
    if (dispatch.releasedAt !== null) return "released";
    orm(db)
      .update(retroDispatch)
      .set({
        result: text,
        resultAt: input.now,
        releasedAt: input.now,
        releaseReason: "result",
        acknowledgedAt: sql`COALESCE(${retroDispatch.acknowledgedAt}, ${input.now})`,
      })
      .where(eq(retroDispatch.commandId, input.commandId))
      .run();
    return "recorded";
  });
}

export function releaseRetroDispatch(
  db: Database,
  input: { commandId: string; reason: Exclude<RetroDispatchRelease, "result">; now: number },
): boolean {
  return (
    changes(
      orm(db)
        .update(retroDispatch)
        .set({ releasedAt: input.now, releaseReason: input.reason })
        .where(and(eq(retroDispatch.commandId, input.commandId), unreleased)),
    ) === 1
  );
}

export function settleRetroDispatch(db: Database, commandId: string, now: number): void {
  orm(db)
    .update(retroDispatch)
    .set({ settledAt: sql`COALESCE(${retroDispatch.settledAt}, ${now})` })
    .where(and(eq(retroDispatch.commandId, commandId), isNotNull(retroDispatch.releasedAt)))
    .run();
}

export function recordRetroGeneration(
  db: Database,
  input: {
    retroId: string;
    diagnostic: RetroGenerationDiagnostic;
    detail: string;
    now: number;
    until?: number | null;
    activeMs?: number;
  },
): RetroGenerationRow {
  return immediate(db, () => {
    const previous = retroGeneration(db, input.retroId);
    const waited =
      previous !== null && RETRO_WAIT_DIAGNOSTICS.includes(previous.diagnostic)
        ? Math.max(0, input.now - previous.updatedAt)
        : 0;
    const since =
      previous !== null && previous.diagnostic === input.diagnostic ? previous.since : input.now;
    const row = {
      retroId: input.retroId,
      diagnostic: input.diagnostic,
      detail: input.detail.slice(0, 2000),
      since,
      until: input.until ?? null,
      waitMs: (previous?.waitMs ?? 0) + waited,
      activeMs: (previous?.activeMs ?? 0) + Math.max(0, input.activeMs ?? 0),
      updatedAt: input.now,
    };
    orm(db)
      .insert(generation)
      .values(row)
      .onConflictDoUpdate({ target: generation.retroId, set: { ...row, retroId: undefined } })
      .run();
    return retroGeneration(db, input.retroId)!;
  });
}

export function retroGeneration(db: Database, retroId: string): RetroGenerationRow | null {
  const row = orm(db).select().from(generation).where(eq(generation.retroId, retroId)).get();
  return row === undefined
    ? null
    : { ...row, diagnostic: row.diagnostic as RetroGenerationDiagnostic };
}
