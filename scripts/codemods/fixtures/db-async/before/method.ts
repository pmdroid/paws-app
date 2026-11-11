import type { Database } from "bun:sqlite";
import { loadItem } from "./db/items";

export class Shelf {
  constructor(private readonly db: Database) {}

  private label(name: string): string {
    return loadItem(this.db, name);
  }

  shout(name: string): string {
    return this.label(name).toUpperCase();
  }
}
