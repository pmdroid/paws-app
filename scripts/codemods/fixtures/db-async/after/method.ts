import type { Database } from "bun:sqlite";
import { loadItem } from "./db/items";
import { sqliteDb } from "./db/db";

export class Shelf {
  constructor(private readonly db: Database) {}

  private async label(name: string): Promise<string> {
    return await loadItem(sqliteDb(this.db), name);
  }

  async shout(name: string): Promise<string> {
    return (await this.label(name)).toUpperCase();
  }
}
