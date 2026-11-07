import type { Database } from "bun:sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

type RepositoryCommandSettlement =
  | { state: "pending" | "delivered" }
  | { state: "done"; result: string }
  | { state: "expired" };

function* readSteps(q: Q, id: string) {
  const command = q.t.runnerRepositoryCommand;
  return yield* q.one(
    q.orm
      .select({ state: command.state, result: command.result, expiresAt: command.expiresAt })
      .from(command)
      .where(eq(command.id, id)),
  );
}

export function* repositoryCommandSettlementSteps(
  q: Q,
  id: string,
  at: number,
): Steps<RepositoryCommandSettlement | null> {
  const command = q.t.runnerRepositoryCommand;
  let row = yield* readSteps(q, id);
  if (!row) return null;
  if ((row.state === "pending" || row.state === "delivered") && row.expiresAt <= at) {
    yield* q.exec(
      q.orm
        .update(command)
        .set({ state: "expired", grantHash: null })
        .where(and(eq(command.id, id), inArray(command.state, ["pending", "delivered"]))),
    );
    row = (yield* readSteps(q, id))!;
  }
  if (row.state === "done" && row.result !== null) return { state: "done", result: row.result };
  if (row.state === "pending" || row.state === "delivered") return { state: row.state };
  return { state: "expired" };
}

export function repositoryCommandSettlement(
  db: Database,
  id: string,
  at: number,
): RepositoryCommandSettlement | null {
  return settled(sqliteDb(db).run((q) => repositoryCommandSettlementSteps(q, id, at)));
}
