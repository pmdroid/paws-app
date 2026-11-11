import type { Database } from "bun:sqlite";
import { countItems } from "./db/items";

export type Counter = typeof countItems;

export function countTwice(db: Database): number {
  return countItems(db, "a") * 2;
}
