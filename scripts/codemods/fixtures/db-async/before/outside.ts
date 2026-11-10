import type { Database } from "bun:sqlite";
import { labelItem } from "./db/items";

export function label(db: Database): string {
  return labelItem(db, "a");
}
