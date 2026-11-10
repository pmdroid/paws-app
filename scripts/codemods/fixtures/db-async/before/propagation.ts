import type { Database } from "bun:sqlite";
import { saveItem } from "./db/items";

function store(db: Database, name: string): void {
  saveItem(db, name);
}

export function storeTwice(db: Database): void {
  store(db, "a");
  store(db, "b");
}
