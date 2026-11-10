import type { Db } from "./db/db";
import { countItems } from "./db/items";

export function totalFor(store: Db): number {
  return countItems(store, "b");
}
