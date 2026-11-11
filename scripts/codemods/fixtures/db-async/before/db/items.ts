import type { Database } from "bun:sqlite";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";

export function* countItemsSteps(_q: Q, kind: string): Steps<number> {
  yield kind;
  return kind.length;
}

/** How many items of the kind exist. */
export function countItems(db: Database, kind: string): number {
  return settled(sqliteDb(db).run((q) => countItemsSteps(q, kind)));
}

export function* saveItemSteps(_q: Q, name: string): Steps<void> {
  yield name;
}

export function saveItem(db: Database, name: string): void {
  settled(sqliteDb(db).transaction((q) => saveItemSteps(q, name)));
}

export function* loadItemSteps(_q: Q, name: string): Steps<string> {
  yield name;
  return name;
}

export function loadItem(db: Database, name: string): string {
  return settled(sqliteDb(db).run((q) => loadItemSteps(q, name)));
}

export async function loadItemAsync(store: Db, name: string): Promise<string> {
  return store.run((q) => loadItemSteps(q, name));
}

export function* describeItemSteps(_q: Q, name: string): Steps<string> {
  yield name;
  return `item ${name}`;
}

export function describeItem(db: Database, name: string): string {
  return settled(sqliteDb(db).run((q) => describeItemSteps(q, name)));
}

export function* touchItemSteps(_q: Q, name: string): Steps<void> {
  yield name;
}

export function touchItem(db: Database, name: string): void {
  settled(sqliteDb(db).run((q) => touchItemSteps(q, name)));
}

export function* labelItemSteps(_q: Q, name: string): Steps<string> {
  yield name;
  return name.toUpperCase();
}

export function labelItem(db: Database, name: string): string {
  return settled(sqliteDb(db).run((q) => labelItemSteps(q, name)));
}

export function itemFile(db: Database): string {
  return db.filename;
}

export function* bumpItemSteps(_q: Q, name: string): Steps<boolean> {
  yield name;
  return true;
}

export function bumpItem(db: Database, name: string): boolean {
  const bumped = settled(sqliteDb(db).run((q) => bumpItemSteps(q, name)));
  if (bumped) console.log(name);
  return bumped;
}
