import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { orm } from "./orm";
import { itemCandidate } from "./schema";

export type ItemCandidate = {
  itemId: string;
  sha: string;
  branch: string;
  recordedAt: number;
};

export function recordItemCandidate(db: Database, candidate: ItemCandidate): void {
  const { sha, branch, recordedAt } = candidate;
  orm(db)
    .insert(itemCandidate)
    .values(candidate)
    .onConflictDoUpdate({ target: itemCandidate.itemId, set: { sha, branch, recordedAt } })
    .run();
}

export function getItemCandidate(db: Database, itemId: string): ItemCandidate | null {
  return orm(db).select().from(itemCandidate).where(eq(itemCandidate.itemId, itemId)).get() ?? null;
}
