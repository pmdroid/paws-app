import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import type * as pgSchema from "./schema-pg";
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

function jsonIn(q: Q, value: unknown): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(value) : value;
}

function jsonOut(q: Q, stored: unknown): unknown {
  return q.dialect === "sqlite" ? (JSON.parse(stored as string) as unknown) : stored;
}

type DispatchRow = typeof pgSchema.retroDispatch.$inferSelect;

function fromRow(q: Q, row: DispatchRow): RetroDispatch {
  return {
    ...row,
    command: jsonOut(q, row.command),
    envelope: jsonOut(q, row.envelope),
    result: row.result === null ? null : jsonOut(q, row.result),
    releaseReason: row.releaseReason as RetroDispatchRelease | null,
  };
}

const unreleased = (q: Q) => isNull(q.t.retroDispatch.releasedAt);
const unfinished = (q: Q) => or(unreleased(q), isNull(q.t.retroDispatch.settledAt));

type NewRetroDispatch = {
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
};

export function recordRetroDispatch(db: Database, input: NewRetroDispatch): RetroDispatch {
  return settled(sqliteDb(db).run((q) => recordRetroDispatchSteps(q, input)));
}

export function* recordRetroDispatchSteps(q: Q, input: NewRetroDispatch) {
  yield* q.exec(
    q.orm.insert(q.t.retroDispatch).values({
      commandId: input.commandId,
      retroId: input.retroId,
      attempt: input.attempt,
      workspaceId: input.workspaceId,
      runnerId: input.runnerId,
      runnerFence: input.runnerFence,
      command: jsonIn(q, input.command),
      envelope: jsonIn(q, input.envelope),
      createdAt: input.now,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    }),
  );
  return (yield* getRetroDispatchSteps(q, input.commandId))!;
}

export function getRetroDispatch(db: Database, commandId: string): RetroDispatch | null {
  return settled(sqliteDb(db).run((q) => getRetroDispatchSteps(q, commandId)));
}

export function* getRetroDispatchSteps(q: Q, commandId: string) {
  const { retroDispatch } = q.t;
  const row = yield* q.one(
    q.orm.select().from(retroDispatch).where(eq(retroDispatch.commandId, commandId)),
  );
  return row === undefined ? null : fromRow(q, row);
}

export function listRetroDispatches(db: Database, retroId: string): RetroDispatch[] {
  return settled(sqliteDb(db).run((q) => listRetroDispatchesSteps(q, retroId)));
}

export function* listRetroDispatchesSteps(q: Q, retroId: string) {
  const { retroDispatch } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(retroDispatch)
      .where(eq(retroDispatch.retroId, retroId))
      .orderBy(retroDispatch.attempt),
  );
  return rows.map((row) => fromRow(q, row));
}

export function openRetroDispatch(db: Database, retroId: string): RetroDispatch | null {
  return settled(sqliteDb(db).run((q) => openRetroDispatchSteps(q, retroId)));
}

export function* openRetroDispatchSteps(q: Q, retroId: string) {
  const { retroDispatch } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(retroDispatch)
      .where(and(eq(retroDispatch.retroId, retroId), unfinished(q)))
      .orderBy(desc(retroDispatch.attempt))
      .limit(1),
  );
  return row === undefined ? null : fromRow(q, row);
}

export function unfinishedRetroDispatches(db: Database): RetroDispatch[] {
  return settled(sqliteDb(db).run((q) => unfinishedRetroDispatchesSteps(q)));
}

export function* unfinishedRetroDispatchesSteps(q: Q) {
  const { retroDispatch } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(retroDispatch)
      .where(unfinished(q))
      .orderBy(retroDispatch.createdAt, retroDispatch.commandId),
  );
  return rows.map((row) => fromRow(q, row));
}

export function deliverableRetroDispatches(db: Database, runnerId: string): RetroDispatch[] {
  return settled(sqliteDb(db).run((q) => deliverableRetroDispatchesSteps(q, runnerId)));
}

export function* deliverableRetroDispatchesSteps(q: Q, runnerId: string) {
  const { retroDispatch } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(retroDispatch)
      .where(
        and(
          eq(retroDispatch.runnerId, runnerId),
          unreleased(q),
          isNull(retroDispatch.acknowledgedAt),
          isNull(retroDispatch.cancelRequestedAt),
        ),
      )
      .orderBy(retroDispatch.createdAt, retroDispatch.commandId)
      .limit(16),
  );
  return rows.map((row) => fromRow(q, row));
}

export function retroSlotsHeld(db: Database, runnerId: string): number {
  return settled(sqliteDb(db).run((q) => retroSlotsHeldSteps(q, runnerId)));
}

export function* retroSlotsHeldSteps(q: Q, runnerId: string) {
  const { retroDispatch } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ held: count() })
      .from(retroDispatch)
      .where(and(eq(retroDispatch.runnerId, runnerId), unreleased(q))),
  );
  return row!.held;
}

export function retroDispatchesNotStarted(db: Database, retroId: string): number {
  return settled(sqliteDb(db).run((q) => retroDispatchesNotStartedSteps(q, retroId)));
}

export function* retroDispatchesNotStartedSteps(q: Q, retroId: string) {
  const { retroDispatch } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(retroDispatch)
      .where(
        and(eq(retroDispatch.retroId, retroId), eq(retroDispatch.releaseReason, "not_started")),
      ),
  );
  return row!.count;
}

export function markRetroDispatchFetched(db: Database, commandId: string, now: number): void {
  settled(sqliteDb(db).run((q) => markRetroDispatchFetchedSteps(q, commandId, now)));
}

export function* markRetroDispatchFetchedSteps(q: Q, commandId: string, now: number) {
  const { retroDispatch } = q.t;
  yield* q.exec(
    q.orm
      .update(retroDispatch)
      .set({ fetchedAt: sql`COALESCE(${retroDispatch.fetchedAt}, ${now})` })
      .where(and(eq(retroDispatch.commandId, commandId), unreleased(q))),
  );
}

type Resign = { commandId: string; envelope: unknown; issuedAt: number; expiresAt: number };

export function resignRetroDispatch(db: Database, input: Resign): boolean {
  return settled(sqliteDb(db).run((q) => resignRetroDispatchSteps(q, input)));
}

export function* resignRetroDispatchSteps(q: Q, input: Resign) {
  const { retroDispatch } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(retroDispatch)
      .set({
        envelope: jsonIn(q, input.envelope),
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        deliveries: sql`${retroDispatch.deliveries} + 1`,
      })
      .where(
        and(
          eq(retroDispatch.commandId, input.commandId),
          unreleased(q),
          isNull(retroDispatch.fetchedAt),
          isNull(retroDispatch.acknowledgedAt),
        ),
      )
      .returning({ commandId: retroDispatch.commandId }),
  );
  return changed.length === 1;
}

export function acknowledgeRetroDispatch(db: Database, commandId: string, now: number): boolean {
  return settled(sqliteDb(db).run((q) => acknowledgeRetroDispatchSteps(q, commandId, now)));
}

export function* acknowledgeRetroDispatchSteps(q: Q, commandId: string, now: number) {
  const { retroDispatch } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(retroDispatch)
      .set({
        acknowledgedAt: sql`COALESCE(${retroDispatch.acknowledgedAt}, ${now})`,
        fetchedAt: sql`COALESCE(${retroDispatch.fetchedAt}, ${now})`,
      })
      .where(
        and(
          eq(retroDispatch.commandId, commandId),
          unreleased(q),
          isNull(retroDispatch.cancelRequestedAt),
        ),
      )
      .returning({ commandId: retroDispatch.commandId }),
  );
  return changed.length === 1;
}

export function requestRetroDispatchCancel(db: Database, commandId: string, now: number): void {
  settled(sqliteDb(db).run((q) => requestRetroDispatchCancelSteps(q, commandId, now)));
}

export function* requestRetroDispatchCancelSteps(q: Q, commandId: string, now: number) {
  const { retroDispatch } = q.t;
  yield* q.exec(
    q.orm
      .update(retroDispatch)
      .set({ cancelRequestedAt: sql`COALESCE(${retroDispatch.cancelRequestedAt}, ${now})` })
      .where(and(eq(retroDispatch.commandId, commandId), unreleased(q))),
  );
}

type DispatchResult = { commandId: string; result: unknown; now: number };

export function recordRetroDispatchResult(
  db: Database,
  input: DispatchResult,
): "recorded" | "duplicate" | "conflict" | "released" {
  return settled(sqliteDb(db).transaction((q) => recordRetroDispatchResultSteps(q, input)));
}

export function* recordRetroDispatchResultSteps(q: Q, input: DispatchResult) {
  const { retroDispatch } = q.t;
  const dispatch = yield* getRetroDispatchSteps(q, input.commandId);
  if (dispatch === null) return "released" as const;
  const text = JSON.stringify(input.result);
  if (dispatch.result !== null) {
    const same =
      q.dialect === "sqlite"
        ? JSON.stringify(dispatch.result) === text
        : isDeepStrictEqual(dispatch.result, JSON.parse(text));
    return same ? ("duplicate" as const) : ("conflict" as const);
  }
  if (dispatch.releasedAt !== null) return "released" as const;
  yield* q.exec(
    q.orm
      .update(retroDispatch)
      .set({
        result: jsonIn(q, input.result),
        resultAt: input.now,
        releasedAt: input.now,
        releaseReason: "result",
        acknowledgedAt: sql`COALESCE(${retroDispatch.acknowledgedAt}, ${input.now})`,
      })
      .where(eq(retroDispatch.commandId, input.commandId)),
  );
  return "recorded" as const;
}

type Release = { commandId: string; reason: Exclude<RetroDispatchRelease, "result">; now: number };

export function releaseRetroDispatch(db: Database, input: Release): boolean {
  return settled(sqliteDb(db).run((q) => releaseRetroDispatchSteps(q, input)));
}

export function* releaseRetroDispatchSteps(q: Q, input: Release) {
  const { retroDispatch } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(retroDispatch)
      .set({ releasedAt: input.now, releaseReason: input.reason })
      .where(and(eq(retroDispatch.commandId, input.commandId), unreleased(q)))
      .returning({ commandId: retroDispatch.commandId }),
  );
  return changed.length === 1;
}

export function settleRetroDispatch(db: Database, commandId: string, now: number): void {
  settled(sqliteDb(db).run((q) => settleRetroDispatchSteps(q, commandId, now)));
}

export function* settleRetroDispatchSteps(q: Q, commandId: string, now: number) {
  const { retroDispatch } = q.t;
  yield* q.exec(
    q.orm
      .update(retroDispatch)
      .set({ settledAt: sql`COALESCE(${retroDispatch.settledAt}, ${now})` })
      .where(and(eq(retroDispatch.commandId, commandId), isNotNull(retroDispatch.releasedAt))),
  );
}

type Generation = {
  retroId: string;
  diagnostic: RetroGenerationDiagnostic;
  detail: string;
  now: number;
  until?: number | null;
  activeMs?: number;
};

export function recordRetroGeneration(db: Database, input: Generation): RetroGenerationRow {
  return settled(sqliteDb(db).transaction((q) => recordRetroGenerationSteps(q, input)));
}

export function* recordRetroGenerationSteps(q: Q, input: Generation) {
  const { retroGeneration: generation } = q.t;
  const previous = yield* retroGenerationSteps(q, input.retroId);
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
  yield* q.exec(
    q.orm
      .insert(generation)
      .values(row)
      .onConflictDoUpdate({ target: generation.retroId, set: { ...row, retroId: undefined } }),
  );
  return (yield* retroGenerationSteps(q, input.retroId))!;
}

export function retroGeneration(db: Database, retroId: string): RetroGenerationRow | null {
  return settled(sqliteDb(db).run((q) => retroGenerationSteps(q, retroId)));
}

export function* retroGenerationSteps(q: Q, retroId: string) {
  const { retroGeneration: generation } = q.t;
  const row = yield* q.one(q.orm.select().from(generation).where(eq(generation.retroId, retroId)));
  return row === undefined
    ? null
    : ({ ...row, diagnostic: row.diagnostic as RetroGenerationDiagnostic } as RetroGenerationRow);
}
