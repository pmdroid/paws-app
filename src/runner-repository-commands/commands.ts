import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  getWorkItemRepository,
  immediate,
  repositoryCommandSettlement,
  workspaceMemberUsableSql,
} from "../db";
import { journalCaught } from "../journal";
import {
  REPOSITORY_COMMAND_RUNNER_VERSION,
  RunnerCommandSchema,
  RunnerRepositoryCommandResultSchema,
  runnerReleaseAtLeast,
  type RunnerRepositoryCommand,
  type RunnerRepositoryCommandResult,
} from "../runner-protocol";
import { workspaceId, workspaceSecret, workspaceTokenHash } from "../workspace";

export type RepositoryCommandOutcome = RunnerRepositoryCommandResult | { outcome: "expired" };

export type RepositoryCommandInput = Omit<RunnerRepositoryCommand, "id" | "type" | "issuedAt"> & {
  now?: number;
};

export const REPOSITORY_COMMAND_GRANT_MS = 60_000;
const SETTLED_RETENTION_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 250;

export class RepositoryCommandDeniedError extends Error {
  override readonly name = "RepositoryCommandDeniedError";
}

type Row = {
  id: string;
  runnerId: string;
  payload: string;
  state: "pending" | "delivered" | "done" | "expired";
  result: string | null;
  grantHash: string | null;
  grantExpiresAt: number | null;
  expiresAt: number;
};
const columns =
  "id,runner_id AS runnerId,payload,state,result,grant_hash AS grantHash,grant_expires_at AS grantExpiresAt,expires_at AS expiresAt";

type Waiter = {
  promise: Promise<RepositoryCommandOutcome>;
  resolve(outcome: RepositoryCommandOutcome): void;
};
const instanceWaiters = new WeakMap<Database, Map<string, Waiter>>();

function waitersOf(db: Database) {
  let waiters = instanceWaiters.get(db);
  if (!waiters) instanceWaiters.set(db, (waiters = new Map()));
  return waiters;
}

function waiter(db: Database, id: string): Waiter {
  const waiters = waitersOf(db);
  const existing = waiters.get(id);
  if (existing) return existing;
  let resolve!: (outcome: RepositoryCommandOutcome) => void;
  const promise = new Promise<RepositoryCommandOutcome>((done) => (resolve = done));
  const created = { promise, resolve };
  waiters.set(id, created);
  return created;
}

function settle(db: Database, id: string, outcome: RepositoryCommandOutcome) {
  const settled = waiter(db, id);
  settled.resolve(outcome);
  setTimeout(() => {
    if (waitersOf(db).get(id) === settled) waitersOf(db).delete(id);
  }, SETTLED_RETENTION_MS).unref();
}

function parse(payload: string): RunnerRepositoryCommand {
  const command = RunnerCommandSchema.parse(JSON.parse(payload));
  if (command.type !== "rebase") throw new Error("Repository command payload is invalid.");
  return command;
}

function expire(db: Database, at: number) {
  const expired = db
    .query<{ id: string }, [number]>(
      "UPDATE runner_repository_command SET state='expired',grant_hash=NULL WHERE state IN ('pending','delivered') AND expires_at<=? RETURNING id",
    )
    .all(at);
  for (const { id } of expired) settle(db, id, { outcome: "expired" });
}

function activeRunner(db: Database, runnerId: string, workspace: string) {
  return (
    db
      .query(
        `SELECT 1 FROM runner r
        JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
        WHERE r.id=? AND r.workspace_id=? AND r.revoked_at IS NULL AND r.status='active' AND ${workspaceMemberUsableSql("m")}`,
      )
      .get(runnerId, workspace) !== null
  );
}

function itemMatches(db: Database, command: RunnerRepositoryCommand) {
  const item = getWorkItem(db, command.itemId);
  const repository = getWorkItemRepository(db, command.itemId);
  return (
    item?.branchName === command.branch &&
    repository?.owner === command.repository.owner &&
    repository.repo === command.repository.repo &&
    repository.remoteUrl === command.repository.remoteUrl
  );
}

export function enqueueRepositoryCommand(db: Database, input: RepositoryCommandInput): string {
  const { now, ...fields } = input;
  const at = now ?? Date.now();
  const command = parse(
    JSON.stringify({ ...fields, id: workspaceId(at), type: "rebase", issuedAt: at }),
  );
  return immediate(db, () => {
    if (!activeRunner(db, command.runnerId, command.workspaceId))
      throw new RepositoryCommandDeniedError("Runner is not accepting repository commands.");
    const version = db
      .query<{ version: string | null }, [string]>(
        "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
      )
      .get(command.runnerId)?.version;
    if (!runnerReleaseAtLeast(version, REPOSITORY_COMMAND_RUNNER_VERSION))
      throw new RepositoryCommandDeniedError(
        `Repository commands need runner ${REPOSITORY_COMMAND_RUNNER_VERSION.join(".")} or later.`,
      );
    if (!itemMatches(db, command))
      throw new RepositoryCommandDeniedError("Repository command does not match its work item.");
    db.run(
      `INSERT INTO runner_repository_command(id,runner_id,item_id,payload,state,expires_at,created_at)
      VALUES(?,?,?,?,'pending',?,?)`,
      [
        command.id,
        command.runnerId,
        command.itemId,
        JSON.stringify(command),
        command.expiresAt,
        at,
      ],
    );
    waiter(db, command.id);
    setTimeout(
      () => {
        try {
          const row = db
            .query<{ state: Row["state"] }, [string]>(
              "UPDATE runner_repository_command SET state=CASE WHEN state IN ('pending','delivered') THEN 'expired' ELSE state END,grant_hash=NULL WHERE id=? RETURNING state",
            )
            .get(command.id);
          if (row?.state !== "done") settle(db, command.id, { outcome: "expired" });
        } catch (error) {
          journalCaught(error, "runner-repository-commands.enqueue.expire", null);
          settle(db, command.id, { outcome: "expired" });
        }
      },
      Math.max(0, command.expiresAt - at),
    ).unref();
    return command.id;
  });
}

export async function waitForRepositoryCommand(
  db: Database,
  id: string,
  signal?: AbortSignal,
): Promise<RepositoryCommandOutcome> {
  signal?.throwIfAborted();
  const local = waitersOf(db).get(id);
  const done = new AbortController();
  const stop = signal ? AbortSignal.any([signal, done.signal]) : done.signal;
  try {
    return await Promise.race(local ? [local.promise, poll(db, id, stop)] : [poll(db, id, stop)]);
  } finally {
    done.abort();
  }
}

async function poll(db: Database, id: string, signal: AbortSignal) {
  for (;;) {
    const row = repositoryCommandSettlement(db, id, Date.now());
    if (!row) throw new Error("Repository command is unknown.");
    if (row.state === "done")
      return RunnerRepositoryCommandResultSchema.parse(JSON.parse(row.result));
    if (row.state === "expired") return { outcome: "expired" } as const;
    await pause(POLL_INTERVAL_MS, signal);
  }
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function deliverRepositoryCommands(
  db: Database,
  runnerId: string,
  at: number,
  limit: number,
): RunnerRepositoryCommand[] {
  if (limit <= 0) return [];
  expire(db, at);
  return immediate(db, () => {
    const rows = db
      .query<Row, [string, number, number]>(
        `SELECT ${columns} FROM runner_repository_command
        WHERE runner_id=? AND state='pending' AND expires_at>? ORDER BY created_at,id LIMIT ?`,
      )
      .all(runnerId, at, limit);
    for (const row of rows)
      db.run("UPDATE runner_repository_command SET state='delivered',delivered_at=? WHERE id=?", [
        at,
        row.id,
      ]);
    return rows.map((row) => parse(row.payload));
  });
}

function current(db: Database, runnerId: string, commandId: string, at: number) {
  const row = db
    .query<Row, [string]>(`SELECT ${columns} FROM runner_repository_command WHERE id=?`)
    .get(commandId);
  if (!row || row.runnerId !== runnerId || row.state !== "delivered" || row.expiresAt <= at)
    throw new RepositoryCommandDeniedError("Repository command is not current.");
  const command = parse(row.payload);
  if (!activeRunner(db, runnerId, command.workspaceId) || !itemMatches(db, command))
    throw new RepositoryCommandDeniedError("Repository command is not current.");
  return { row, command };
}

export function issueRepositoryCommandGrant(
  db: Database,
  input: { runnerId: string; commandId: string },
  at: number,
) {
  expire(db, at);
  return immediate(db, () => {
    const { command } = current(db, input.runnerId, input.commandId, at);
    const token = workspaceSecret();
    const expiresAt = Math.min(command.expiresAt, at + REPOSITORY_COMMAND_GRANT_MS);
    db.run("UPDATE runner_repository_command SET grant_hash=?,grant_expires_at=? WHERE id=?", [
      workspaceTokenHash(token),
      expiresAt,
      command.id,
    ]);
    return { token, expiresAt };
  });
}

export function authorizeRepositoryCommand(
  db: Database,
  input: { runnerId: string; commandId: string; token: string },
  at: number,
): RunnerRepositoryCommand {
  expire(db, at);
  return immediate(db, () => {
    const { row, command } = current(db, input.runnerId, input.commandId, at);
    if (
      row.grantHash === null ||
      row.grantHash !== workspaceTokenHash(input.token) ||
      (row.grantExpiresAt ?? 0) <= at
    )
      throw new RepositoryCommandDeniedError("Repository command grant is invalid or expired.");
    return command;
  });
}

export function recordRepositoryCommandResult(
  db: Database,
  input: { runnerId: string; commandId: string; result: RunnerRepositoryCommandResult },
  at: number,
) {
  const result = RunnerRepositoryCommandResultSchema.parse(input.result);
  const stored = JSON.stringify(result);
  expire(db, at);
  const recorded = immediate(db, () => {
    const row = db
      .query<Row, [string]>(`SELECT ${columns} FROM runner_repository_command WHERE id=?`)
      .get(input.commandId);
    if (!row || row.runnerId !== input.runnerId)
      throw new RepositoryCommandDeniedError("Repository command is unknown.");
    if (row.state === "done") {
      if (row.result !== stored)
        throw new RepositoryCommandDeniedError("Repository command already has another result.");
      return false;
    }
    if (row.state !== "delivered" || row.expiresAt <= at)
      throw new RepositoryCommandDeniedError("Repository command is not current.");
    db.run(
      "UPDATE runner_repository_command SET state='done',result=?,done_at=?,grant_hash=NULL WHERE id=?",
      [stored, at, row.id],
    );
    return true;
  });
  if (recorded) settle(db, input.commandId, result);
  return { duplicate: !recorded };
}

export function repositoryCommandDeliveredTo(db: Database, runnerId: string, id: string) {
  return (
    db
      .query(
        "SELECT 1 FROM runner_repository_command WHERE id=? AND runner_id=? AND state<>'pending'",
      )
      .get(id, runnerId) !== null
  );
}

export function repositoryCommandState(db: Database, id: string, at = Date.now()) {
  expire(db, at);
  return (
    db
      .query<{ state: Row["state"] }, [string]>(
        "SELECT state FROM runner_repository_command WHERE id=?",
      )
      .get(id)?.state ?? null
  );
}

function cancelRepositoryCommand(db: Database, id: string) {
  const cancelled = db
    .query(
      "UPDATE runner_repository_command SET state='expired',grant_hash=NULL WHERE id=? AND state IN ('pending','delivered') RETURNING id",
    )
    .get(id);
  if (cancelled) settle(db, id, { outcome: "expired" });
}

const REPOSITORY_REBASE_TIMEOUT_MS = 10 * 60_000;

export async function rebaseOnRunner(
  db: Database,
  input: Omit<RepositoryCommandInput, "expiresAt" | "now"> & { now: number },
  signal?: AbortSignal,
): Promise<RunnerRepositoryCommandResult> {
  try {
    signal?.throwIfAborted();
    const id = enqueueRepositoryCommand(db, {
      ...input,
      expiresAt: input.now + REPOSITORY_REBASE_TIMEOUT_MS,
    });
    const outcome = await waitForRepositoryCommand(db, id, signal).catch((error: unknown) => {
      cancelRepositoryCommand(db, id);
      throw error;
    });
    return outcome.outcome === "expired"
      ? { outcome: "failed", reason: "timed out after 10 minutes" }
      : outcome;
  } catch (error) {
    if (!(error instanceof RepositoryCommandDeniedError)) throw error;
    return { outcome: "failed", reason: error.message };
  }
}
