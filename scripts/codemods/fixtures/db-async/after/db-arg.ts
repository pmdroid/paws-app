import type { Db } from "./db/db";
import { countItems } from "./db/items";

export async function totalFor(store: Db): Promise<number> {
  return await countItems(store, "b");
}
