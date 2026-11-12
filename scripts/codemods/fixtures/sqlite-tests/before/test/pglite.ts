import type { Db } from "../db";

export async function tempStore(): Promise<{ db: Db; close(): Promise<void> }> {
  throw new Error("fixture");
}
