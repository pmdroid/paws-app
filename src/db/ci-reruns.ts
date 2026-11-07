import type { Database } from "bun:sqlite";
import { and, asc, eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
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

export function hasCiRerun(db: Database, itemId: string, head: string): boolean {
  return settled(sqliteDb(db).run((q) => hasCiRerunSteps(q, itemId, head)));
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

export function recordCiRerun(db: Database, rerun: CiRerun): boolean {
  return settled(sqliteDb(db).run((q) => recordCiRerunSteps(q, rerun)));
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

export function listCiReruns(db: Database, itemId: string): CiRerun[] {
  return settled(sqliteDb(db).run((q) => listCiRerunsSteps(q, itemId)));
}
