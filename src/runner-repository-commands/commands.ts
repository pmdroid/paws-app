import type { Database } from "bun:sqlite";
import {
  cancelOpenRepositoryCommand,
  completeRepositoryCommand,
  expireDueRepositoryCommands,
  expireRepositoryCommand,
  getWorkItem,
  getWorkItemRepository,
  immediate,
  insertRepositoryCommand,
  markRepositoryCommandDelivered,
  pendingRepositoryCommands,
  repositoryCommandReachedRunner,
  repositoryCommandRow,
  repositoryCommandSettlement,
  runnerHostVersion,
  setRepositoryCommandGrant,
  usableRunner,
} from "../db";
import { journalCaught } from "../journal";
import {
  REPOSITORY_COMMAND_RUNNER_VERSION,
  RunnerCommandSchema,
  RunnerRepositoryCommandResultSchema,
  SQUASH_REBASE_RUNNER_VERSION,
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
  for (const id of expireDueRepositoryCommands(db, at)) settle(db, id, { outcome: "expired" });
}

function activeRunner(db: Database, runnerId: string, workspace: string) {
  const runner = usableRunner(db, runnerId);
  return runner?.workspaceId === workspace && runner.status === "active";
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

export function rebaseCommitTitle(title: string): string | undefined {
  return (
    title
      .replace(/[\0\r\n]+/g, " ")
      .slice(0, 256)
      .replace(/[\ud800-\udbff]$/, "")
      .trim() || undefined
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
    const version = runnerHostVersion(db, command.runnerId);
    if (!runnerReleaseAtLeast(version, REPOSITORY_COMMAND_RUNNER_VERSION))
      throw new RepositoryCommandDeniedError(
        `Repository commands need runner ${REPOSITORY_COMMAND_RUNNER_VERSION.join(".")} or later.`,
      );
    if (!itemMatches(db, command))
      throw new RepositoryCommandDeniedError("Repository command does not match its work item.");
    const { title: _title, ...untitled } = command;
    insertRepositoryCommand(db, {
      id: command.id,
      runnerId: command.runnerId,
      itemId: command.itemId,
      payload: JSON.stringify(
        runnerReleaseAtLeast(version, SQUASH_REBASE_RUNNER_VERSION) ? command : untitled,
      ),
      expiresAt: command.expiresAt,
      createdAt: at,
    });
    waiter(db, command.id);
    setTimeout(
      () => {
        try {
          if (expireRepositoryCommand(db, command.id) !== "done")
            settle(db, command.id, { outcome: "expired" });
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
    const rows = pendingRepositoryCommands(db, runnerId, at, limit);
    for (const row of rows) markRepositoryCommandDelivered(db, row.id, at);
    return rows.map((row) => parse(row.payload));
  });
}

function current(db: Database, runnerId: string, commandId: string, at: number) {
  const row = repositoryCommandRow(db, commandId);
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
    setRepositoryCommandGrant(db, command.id, workspaceTokenHash(token), expiresAt);
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
    const row = repositoryCommandRow(db, input.commandId);
    if (!row || row.runnerId !== input.runnerId)
      throw new RepositoryCommandDeniedError("Repository command is unknown.");
    if (row.state === "done") {
      if (row.result !== stored)
        throw new RepositoryCommandDeniedError("Repository command already has another result.");
      return false;
    }
    if (row.state !== "delivered" || row.expiresAt <= at)
      throw new RepositoryCommandDeniedError("Repository command is not current.");
    completeRepositoryCommand(db, row.id, stored, at);
    return true;
  });
  if (recorded) settle(db, input.commandId, result);
  return { duplicate: !recorded };
}

export function repositoryCommandDeliveredTo(db: Database, runnerId: string, id: string) {
  return repositoryCommandReachedRunner(db, id, runnerId);
}

export function repositoryCommandState(db: Database, id: string, at = Date.now()) {
  expire(db, at);
  return repositoryCommandRow(db, id)?.state ?? null;
}

function cancelRepositoryCommand(db: Database, id: string) {
  if (cancelOpenRepositoryCommand(db, id)) settle(db, id, { outcome: "expired" });
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
