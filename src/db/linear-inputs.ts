import { and, asc, eq } from "drizzle-orm";
import { type Q, type Db } from "./db";
import type { linearInput } from "./schema";

export type LinearInputRecord = typeof linearInput.$inferSelect;

export function* recordLinearInputSteps(q: Q, input: LinearInputRecord) {
  yield* q.exec(q.orm.insert(q.t.linearInput).values(input).onConflictDoNothing());
}

export async function recordLinearInput(store: Db, input: LinearInputRecord): Promise<void> {
  await store.run((q) => recordLinearInputSteps(q, input));
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

export async function listLinearInputs(
  store: Db,
  sessionId: string,
  turnId: string,
): Promise<LinearInputRecord[]> {
  return store.run((q) => listLinearInputsSteps(q, sessionId, turnId));
}
