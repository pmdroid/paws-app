import { and, asc, eq, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonValue, parsedJson } from "./json-text";

export type CiRerun = {
  itemId: string;
  head: string;
  runIds: number[];
  reason: string;
  at: number;
};

export function* hasCiRerunSteps(q: Q, itemId: string, head: string) {
  const { ciRerun } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(ciRerun)
      .where(and(eq(ciRerun.itemId, itemId), eq(ciRerun.headSha, head))),
  );
  return row !== undefined;
}

export async function hasCiRerun(db: Db, itemId: string, head: string): Promise<boolean> {
  return await db.run((q) => hasCiRerunSteps(q, itemId, head));
}

export function* recordCiRerunSteps(q: Q, rerun: CiRerun) {
  const { ciRerun } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(ciRerun)
      .values({
        itemId: rerun.itemId,
        headSha: rerun.head,
        runIds: jsonValue(q, rerun.runIds),
        reason: rerun.reason,
        at: rerun.at,
      })
      .onConflictDoNothing({ target: [ciRerun.itemId, ciRerun.headSha] })
      .returning({ itemId: ciRerun.itemId }),
  );
  return inserted.length === 1;
}

export async function recordCiRerun(store: Db, rerun: CiRerun): Promise<boolean> {
  return store.run((q) => recordCiRerunSteps(q, rerun));
}

export function* listCiRerunsSteps(q: Q, itemId: string) {
  const { ciRerun } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(ciRerun)
      .where(eq(ciRerun.itemId, itemId))
      .orderBy(asc(ciRerun.at), asc(ciRerun.headSha)),
  );
  return rows.map((row): CiRerun => ({
    itemId: row.itemId,
    head: row.headSha,
    runIds: parsedJson<number[]>(q, row.runIds),
    reason: row.reason,
    at: row.at,
  }));
}

export async function listCiReruns(store: Db, itemId: string): Promise<CiRerun[]> {
  return store.run((q) => listCiRerunsSteps(q, itemId));
}
