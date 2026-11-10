import { type Q, type Steps, type Db } from "./db";

export function* countPickedSteps(_q: Q, kind: string): Steps<number> {
  yield kind;
  return kind.length;
}

export async function countPicked(store: Db, kind: string): Promise<number> {
  return store.run((q) => countPickedSteps(q, kind));
}
