import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import type { linearInput } from "./schema";

export type LinearInputRecord = typeof linearInput.$inferSelect;

export function* recordLinearInputSteps(q: Q, input: LinearInputRecord) {
  yield* q.exec(q.orm.insert(q.t.linearInput).values(input).onConflictDoNothing());
}

export function recordLinearInput(db: Database, input: LinearInputRecord): void {
  settled(sqliteDb(db).run((q) => recordLinearInputSteps(q, input)));
}

export function* listLinearInputsSteps(q: Q, sessionId: string, turnId: string) {
  const { linearInput } = q.t;
  return yield* q.all(
    q.orm
      .select()
      .from(linearInput)
      .where(and(eq(linearInput.sessionId, sessionId), eq(linearInput.turnId, turnId)))
      .orderBy(asc(linearInput.assetId)),
  );
}

export function listLinearInputs(
  db: Database,
  sessionId: string,
  turnId: string,
): LinearInputRecord[] {
  return settled(sqliteDb(db).run((q) => listLinearInputsSteps(q, sessionId, turnId)));
}
