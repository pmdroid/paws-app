import type { Database } from "bun:sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { orm } from "./orm";
import { runnerRepositoryCommand } from "./schema";

type RepositoryCommandSettlement =
  | { state: "pending" | "delivered" }
  | { state: "done"; result: string }
  | { state: "expired" };

function read(db: Database, id: string) {
  return orm(db)
    .select({
      state: runnerRepositoryCommand.state,
      result: runnerRepositoryCommand.result,
      expiresAt: runnerRepositoryCommand.expiresAt,
    })
    .from(runnerRepositoryCommand)
    .where(eq(runnerRepositoryCommand.id, id))
    .get();
}

export function repositoryCommandSettlement(
  db: Database,
  id: string,
  at: number,
): RepositoryCommandSettlement | null {
  let row = read(db, id);
  if (!row) return null;
  if ((row.state === "pending" || row.state === "delivered") && row.expiresAt <= at) {
    orm(db)
      .update(runnerRepositoryCommand)
      .set({ state: "expired", grantHash: null })
      .where(
        and(
          eq(runnerRepositoryCommand.id, id),
          inArray(runnerRepositoryCommand.state, ["pending", "delivered"]),
        ),
      )
      .run();
    row = read(db, id)!;
  }
  if (row.state === "done" && row.result !== null) return { state: "done", result: row.result };
  if (row.state === "pending" || row.state === "delivered") return { state: row.state };
  return { state: "expired" };
}
