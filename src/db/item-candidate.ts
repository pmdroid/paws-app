import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export type ItemCandidate = {
  itemId: string;
  sha: string;
  branch: string;
  recordedAt: number;
};

export function* recordItemCandidateSteps(q: Q, candidate: ItemCandidate) {
  const { itemCandidate } = q.t;
  const { sha, branch, recordedAt } = candidate;
  yield* q.exec(
    q.orm
      .insert(itemCandidate)
      .values(candidate)
      .onConflictDoUpdate({ target: itemCandidate.itemId, set: { sha, branch, recordedAt } }),
  );
}

export function recordItemCandidate(db: Database, candidate: ItemCandidate): void {
  settled(sqliteDb(db).run((q) => recordItemCandidateSteps(q, candidate)));
}

export function* getItemCandidateSteps(q: Q, itemId: string) {
  const { itemCandidate } = q.t;
  const row = yield* q.one(
    q.orm.select().from(itemCandidate).where(eq(itemCandidate.itemId, itemId)),
  );
  return row ?? null;
}

export function getItemCandidate(db: Database, itemId: string): ItemCandidate | null {
  return settled(sqliteDb(db).run((q) => getItemCandidateSteps(q, itemId)));
}
