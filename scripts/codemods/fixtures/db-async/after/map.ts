import type { Database } from "bun:sqlite";
import { describeItem } from "./db/items";

export function describeAll(db: Database, names: string[]): string[] {
  return names.map((name) => describeItem(db, name));
}
