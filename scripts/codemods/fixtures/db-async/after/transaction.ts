import type { Database } from "bun:sqlite";
import { touchItem } from "./db/items";

export function touchBoth(db: Database): void {
  db.transaction(() => {
    touchItem(db, "a");
    touchItem(db, "b");
  })();
}
