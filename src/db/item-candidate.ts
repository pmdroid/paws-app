import { eq } from "drizzle-orm";
import { type Q, type Db } from "./db";

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

export async function recordItemCandidate(store: Db, candidate: ItemCandidate): Promise<void> {
  await store.run((q) => recordItemCandidateSteps(q, candidate));
}

export function* getItemCandidateSteps(q: Q, itemId: string) {
  const { itemCandidate } = q.t;
  const row = yield* q.one(
    q.orm.select().from(itemCandidate).where(eq(itemCandidate.itemId, itemId)),
  );
  return row ?? null;
}

export async function getItemCandidate(store: Db, itemId: string): Promise<ItemCandidate | null> {
  return store.run((q) => getItemCandidateSteps(q, itemId));
}
