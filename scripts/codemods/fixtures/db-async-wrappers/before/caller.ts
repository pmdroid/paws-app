import type { Database } from "bun:sqlite";
import { countPicked } from "./db/picked";
import { countSkipped } from "./db/skipped";

export function total(db: Database): number {
  return countPicked(db, "a") + countSkipped(db, "b");
}
