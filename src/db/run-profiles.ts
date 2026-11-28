import { eq, inArray } from "drizzle-orm";
import { type Q, type Steps } from "./db";

export function* getRunProfileSteps<T>(q: Q, runId: string): Steps<T | null> {
  const { runProfile } = q.t;
  const row = yield* q.one(
    q.orm.select({ record: runProfile.record }).from(runProfile).where(eq(runProfile.runId, runId)),
  );
  return (row?.record as T | undefined) ?? null;
}

export function* listRunProfilesSteps<T>(q: Q, runIds: readonly string[]): Steps<Map<string, T>> {
  const { runProfile } = q.t;
  if (runIds.length === 0) return new Map();
  const rows = yield* q.all(
    q.orm
      .select({ runId: runProfile.runId, record: runProfile.record })
      .from(runProfile)
      .where(inArray(runProfile.runId, [...runIds])),
  );
  return new Map(rows.map((row) => [row.runId, row.record as T]));
}

export function* saveRunProfileSteps(
  q: Q,
  runId: string,
  record: unknown,
  now: number,
): Steps<void> {
  const { runProfile } = q.t;
  yield* q.exec(
    q.orm
      .insert(runProfile)
      .values({ runId, record, updatedAt: now })
      .onConflictDoUpdate({ target: runProfile.runId, set: { record, updatedAt: now } }),
  );
}

export function* keepRunProfileSteps<T>(
  q: Q,
  runId: string,
  record: T,
  now: number,
): Steps<T | null> {
  const { run, runProfile } = q.t;
  if (!(yield* q.one(q.orm.select({ id: run.id }).from(run).where(eq(run.id, runId))))) return null;
  yield* q.exec(
    q.orm.insert(runProfile).values({ runId, record, updatedAt: now }).onConflictDoNothing(),
  );
  return yield* getRunProfileSteps<T>(q, runId);
}
