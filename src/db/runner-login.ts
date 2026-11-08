import type { Database } from "bun:sqlite";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

const PENDING = ["starting", "waiting"];

export type RunnerLoginRow = {
  id: string;
  runnerId: string;
  workspaceId: string;
  userId: string;
  agent: "claude" | "codex" | "grok" | "opencode";
  state: "starting" | "waiting" | "connected" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  terminal: string;
  authorization: string | null;
  inputId: string | null;
  bindingId: string | null;
};

const cleared = { terminal: "", authorization: null, inputId: null };

export function* runnerLoginRowSteps(q: Q, id: string) {
  const { runnerLogin: l } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        id: l.id,
        runnerId: l.runnerId,
        workspaceId: l.workspaceId,
        userId: l.userId,
        agent: sql<RunnerLoginRow["agent"]>`${l.agent}`,
        state: sql<RunnerLoginRow["state"]>`${l.state}`,
        expiresAt: l.expiresAt,
        terminal: l.terminal,
        authorization: l.authorization,
        inputId: l.inputId,
        bindingId: l.bindingId,
      })
      .from(l)
      .where(eq(l.id, id)),
  );
  return row ?? null;
}

export function runnerLoginRow(db: Database, id: string): RunnerLoginRow | null {
  return settled(sqliteDb(db).run((q) => runnerLoginRowSteps(q, id)));
}

export function* closeRunnerLoginSteps(q: Q, id: string, state: "expired" | "cancelled") {
  const { runnerLogin: l } = q.t;
  yield* q.exec(
    q.orm
      .update(l)
      .set({ state, ...cleared })
      .where(eq(l.id, id)),
  );
}

export function closeRunnerLogin(db: Database, id: string, state: "expired" | "cancelled"): void {
  settled(sqliteDb(db).run((q) => closeRunnerLoginSteps(q, id, state)));
}

export function* cancelPendingRunnerLoginsSteps(q: Q, id?: string) {
  const { runnerLogin: l } = q.t;
  yield* q.exec(
    q.orm
      .update(l)
      .set({ state: "cancelled", ...cleared })
      .where(and(inArray(l.state, PENDING), id === undefined ? undefined : eq(l.id, id))),
  );
}

export function cancelPendingRunnerLogins(db: Database, id?: string): void {
  settled(sqliteDb(db).run((q) => cancelPendingRunnerLoginsSteps(q, id)));
}

function* latestLoginIdSteps(q: Q, where: ReturnType<typeof and>) {
  const { runnerLogin: l } = q.t;
  const newestFirst = q.dialect === "sqlite" ? [sql`rowid DESC`] : [desc(l.expiresAt), desc(l.id)];
  const row = yield* q.one(
    q.orm
      .select({ id: l.id })
      .from(l)
      .where(where)
      .orderBy(...newestFirst)
      .limit(1),
  );
  return row?.id ?? null;
}

export function* latestAgentRunnerLoginIdSteps(
  q: Q,
  input: { runnerId: string; userId: string; agent: string },
) {
  const { runnerLogin: l } = q.t;
  return yield* latestLoginIdSteps(
    q,
    and(
      eq(l.runnerId, input.runnerId),
      eq(l.userId, input.userId),
      eq(l.agent, input.agent),
      isNull(l.bindingId),
    ),
  );
}

export function latestAgentRunnerLoginId(
  db: Database,
  input: { runnerId: string; userId: string; agent: string },
): string | null {
  return settled(sqliteDb(db).run((q) => latestAgentRunnerLoginIdSteps(q, input)));
}

export function* latestBindingRunnerLoginIdSteps(
  q: Q,
  input: { runnerId: string; userId: string; bindingId: string },
) {
  const { runnerLogin: l } = q.t;
  return yield* latestLoginIdSteps(
    q,
    and(
      eq(l.runnerId, input.runnerId),
      eq(l.userId, input.userId),
      eq(l.bindingId, input.bindingId),
    ),
  );
}

export function latestBindingRunnerLoginId(
  db: Database,
  input: { runnerId: string; userId: string; bindingId: string },
): string | null {
  return settled(sqliteDb(db).run((q) => latestBindingRunnerLoginIdSteps(q, input)));
}

type PendingLogin = {
  runnerId: string;
  userId: string;
  agent: string;
  bindingId: string | null;
  at: number;
};

export function* pendingRunnerLoginIdSteps(q: Q, input: PendingLogin) {
  const { runnerLogin: l } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: l.id })
      .from(l)
      .where(
        and(
          eq(l.runnerId, input.runnerId),
          eq(l.userId, input.userId),
          eq(l.agent, input.agent),
          input.bindingId === null ? isNull(l.bindingId) : eq(l.bindingId, input.bindingId),
          inArray(l.state, PENDING),
          gt(l.expiresAt, input.at),
        ),
      )
      .limit(1),
  );
  return row?.id ?? null;
}

export function pendingRunnerLoginId(db: Database, input: PendingLogin): string | null {
  return settled(sqliteDb(db).run((q) => pendingRunnerLoginIdSteps(q, input)));
}

export function* pendingRunnerLoginCountSteps(q: Q, runnerId: string, at: number) {
  const { runnerLogin: l } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(l)
      .where(and(eq(l.runnerId, runnerId), inArray(l.state, PENDING), gt(l.expiresAt, at))),
  );
  return row!.count;
}

export function pendingRunnerLoginCount(db: Database, runnerId: string, at: number): number {
  return settled(sqliteDb(db).run((q) => pendingRunnerLoginCountSteps(q, runnerId, at)));
}

type NewRunnerLogin = {
  id: string;
  runnerId: string;
  workspaceId: string;
  userId: string;
  agent: string;
  expiresAt: number;
  updatedAt: number;
  bindingId: string | null;
};

export function* insertRunnerLoginSteps(q: Q, input: NewRunnerLogin) {
  yield* q.exec(q.orm.insert(q.t.runnerLogin).values({ ...input, state: "starting" }));
}

export function insertRunnerLogin(db: Database, input: NewRunnerLogin): void {
  settled(sqliteDb(db).run((q) => insertRunnerLoginSteps(q, input)));
}

type RunnerLoginProgress = {
  state: string;
  terminal: string;
  authorization: string | null;
  inputId: string | null;
  updatedAt: number;
};

export function* updateRunnerLoginSteps(q: Q, id: string, progress: RunnerLoginProgress) {
  const { runnerLogin: l } = q.t;
  yield* q.exec(q.orm.update(l).set(progress).where(eq(l.id, id)));
}

export function updateRunnerLogin(db: Database, id: string, progress: RunnerLoginProgress): void {
  settled(sqliteDb(db).run((q) => updateRunnerLoginSteps(q, id, progress)));
}
