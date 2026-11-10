import type { Database } from "bun:sqlite";
import { countItems } from "./db/items";

export function total(db: Database): number {
  return countItems(db, "a") + 1;
}
