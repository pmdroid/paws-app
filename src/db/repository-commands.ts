import { and, asc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

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

export async function repositoryCommandSettlement(
  store: Db,
  id: string,
  at: number,
): Promise<RepositoryCommandSettlement | null> {
  return store.run((q) => repositoryCommandSettlementSteps(q, id, at));
}

export type RepositoryCommandRow = {
  id: string;
  runnerId: string;
  payload: string;
  state: "pending" | "delivered" | "done" | "expired";
  result: string | null;
  grantHash: string | null;
  grantExpiresAt: number | null;
  expiresAt: number;
};

export function* repositoryCommandRowSteps(q: Q, id: string): Steps<RepositoryCommandRow | null> {
  const command = q.t.runnerRepositoryCommand;
  const row = yield* q.one(
    q.orm
      .select({
        id: command.id,
        runnerId: command.runnerId,
        payload: command.payload,
        state: command.state,
        result: command.result,
        grantHash: command.grantHash,
        grantExpiresAt: command.grantExpiresAt,
        expiresAt: command.expiresAt,
      })
      .from(command)
      .where(eq(command.id, id)),
  );
  return (row as RepositoryCommandRow | undefined) ?? null;
}

export async function repositoryCommandRow(
  store: Db,
  id: string,
): Promise<RepositoryCommandRow | null> {
  return store.run((q) => repositoryCommandRowSteps(q, id));
}

/** Expires every open command whose deadline has passed and returns their ids. */
export function* expireDueRepositoryCommandsSteps(q: Q, at: number): Steps<string[]> {
  const command = q.t.runnerRepositoryCommand;
  const rows = yield* q.all(
    q.orm
      .update(command)
      .set({ state: "expired", grantHash: null })
      .where(and(inArray(command.state, ["pending", "delivered"]), lte(command.expiresAt, at)))
      .returning({ id: command.id }),
  );
  return rows.map((row) => row.id);
}

export async function expireDueRepositoryCommands(store: Db, at: number): Promise<string[]> {
  return store.run((q) => expireDueRepositoryCommandsSteps(q, at));
}

/** At a command's deadline: an open command expires, and any command loses its grant. */
export function* expireRepositoryCommandSteps(q: Q, id: string): Steps<string | null> {
  const command = q.t.runnerRepositoryCommand;
  const row = yield* q.one(
    q.orm
      .update(command)
      .set({
        state: sql`CASE WHEN ${command.state} IN ('pending','delivered') THEN 'expired' ELSE ${command.state} END`,
        grantHash: null,
      })
      .where(eq(command.id, id))
      .returning({ state: command.state }),
  );
  return row?.state ?? null;
}

export async function expireRepositoryCommand(store: Db, id: string): Promise<string | null> {
  return store.run((q) => expireRepositoryCommandSteps(q, id));
}

/** Expires the command if it is still open, and says whether it was. */
export function* cancelOpenRepositoryCommandSteps(q: Q, id: string): Steps<boolean> {
  const command = q.t.runnerRepositoryCommand;
  const rows = yield* q.all(
    q.orm
      .update(command)
      .set({ state: "expired", grantHash: null })
      .where(and(eq(command.id, id), inArray(command.state, ["pending", "delivered"])))
      .returning({ id: command.id }),
  );
  return rows.length > 0;
}

export async function cancelOpenRepositoryCommand(store: Db, id: string): Promise<boolean> {
  return store.run((q) => cancelOpenRepositoryCommandSteps(q, id));
}

type NewRepositoryCommand = {
  id: string;
  runnerId: string;
  itemId: string;
  payload: string;
  expiresAt: number;
  createdAt: number;
};

export function* insertRepositoryCommandSteps(q: Q, row: NewRepositoryCommand) {
  yield* q.exec(q.orm.insert(q.t.runnerRepositoryCommand).values({ ...row, state: "pending" }));
}

export async function insertRepositoryCommand(store: Db, row: NewRepositoryCommand): Promise<void> {
  await store.run((q) => insertRepositoryCommandSteps(q, row));
}

export function* pendingRepositoryCommandsSteps(
  q: Q,
  runnerId: string,
  at: number,
  limit: number,
): Steps<{ id: string; payload: string }[]> {
  const command = q.t.runnerRepositoryCommand;
  return yield* q.all(
    q.orm
      .select({ id: command.id, payload: command.payload })
      .from(command)
      .where(
        and(
          eq(command.runnerId, runnerId),
          eq(command.state, "pending"),
          gt(command.expiresAt, at),
        ),
      )
      .orderBy(asc(command.createdAt), asc(command.id))
      .limit(limit),
  );
}

export async function pendingRepositoryCommands(
  store: Db,
  runnerId: string,
  at: number,
  limit: number,
): Promise<{ id: string; payload: string }[]> {
  return store.run((q) => pendingRepositoryCommandsSteps(q, runnerId, at, limit));
}

export function* markRepositoryCommandDeliveredSteps(q: Q, id: string, at: number) {
  const command = q.t.runnerRepositoryCommand;
  yield* q.exec(
    q.orm.update(command).set({ state: "delivered", deliveredAt: at }).where(eq(command.id, id)),
  );
}

export async function markRepositoryCommandDelivered(
  store: Db,
  id: string,
  at: number,
): Promise<void> {
  await store.run((q) => markRepositoryCommandDeliveredSteps(q, id, at));
}

export function* setRepositoryCommandGrantSteps(
  q: Q,
  id: string,
  grantHash: string,
  grantExpiresAt: number,
) {
  const command = q.t.runnerRepositoryCommand;
  yield* q.exec(q.orm.update(command).set({ grantHash, grantExpiresAt }).where(eq(command.id, id)));
}

export async function setRepositoryCommandGrant(
  store: Db,
  id: string,
  grantHash: string,
  grantExpiresAt: number,
): Promise<void> {
  await store.run((q) => setRepositoryCommandGrantSteps(q, id, grantHash, grantExpiresAt));
}

export function* completeRepositoryCommandSteps(q: Q, id: string, result: string, at: number) {
  const command = q.t.runnerRepositoryCommand;
  yield* q.exec(
    q.orm
      .update(command)
      .set({ state: "done", result, doneAt: at, grantHash: null })
      .where(eq(command.id, id)),
  );
}

export async function completeRepositoryCommand(
  store: Db,
  id: string,
  result: string,
  at: number,
): Promise<void> {
  await store.run((q) => completeRepositoryCommandSteps(q, id, result, at));
}

/** Whether the command belongs to this runner and has left the pending state. */
export function* repositoryCommandReachedRunnerSteps(
  q: Q,
  id: string,
  runnerId: string,
): Steps<boolean> {
  const command = q.t.runnerRepositoryCommand;
  const row = yield* q.one(
    q.orm
      .select({ id: command.id })
      .from(command)
      .where(and(eq(command.id, id), eq(command.runnerId, runnerId), ne(command.state, "pending"))),
  );
  return row !== undefined;
}

export async function repositoryCommandReachedRunner(
  store: Db,
  id: string,
  runnerId: string,
): Promise<boolean> {
  return store.run((q) => repositoryCommandReachedRunnerSteps(q, id, runnerId));
}
