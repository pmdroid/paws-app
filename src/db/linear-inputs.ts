import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export type LinearInputRecord = {
  sessionId: string;
  turnId: string;
  assetId: string;
  assetUrl: string;
  mimeType: string;
  size: number;
  sha256: string;
};

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
      .select({
        sessionId: linearInput.sessionId,
        turnId: linearInput.turnId,
        assetId: linearInput.assetId,
        assetUrl: linearInput.assetUrl,
        mimeType: linearInput.mimeType,
        size: linearInput.size,
        sha256: linearInput.sha256,
      })
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
