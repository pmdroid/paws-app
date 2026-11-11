import {
  cancelOpenRepositoryCommandSteps,
  completeRepositoryCommandSteps,
  expireDueRepositoryCommandsSteps,
  expireRepositoryCommandSteps,
  getWorkItemRepositorySteps,
  getWorkItemSteps,
  insertRepositoryCommandSteps,
  markRepositoryCommandDeliveredSteps,
  pendingRepositoryCommandsSteps,
  repositoryCommandReachedRunnerSteps,
  repositoryCommandRowSteps,
  repositoryCommandSettlementSteps,
  runnerHostVersionSteps,
  setRepositoryCommandGrantSteps,
  usableRunnerSteps,
  type Db,
  type Q,
  type Steps,
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
const instanceWaiters = new WeakMap<Db, Map<string, Waiter>>();

function waitersOf(store: Db) {
  let waiters = instanceWaiters.get(store);
  if (!waiters) instanceWaiters.set(store, (waiters = new Map()));
  return waiters;
}

function waiter(store: Db, id: string): Waiter {
  const waiters = waitersOf(store);
  const existing = waiters.get(id);
  if (existing) return existing;
  let resolve!: (outcome: RepositoryCommandOutcome) => void;
  const promise = new Promise<RepositoryCommandOutcome>((done) => (resolve = done));
  const created = { promise, resolve };
  waiters.set(id, created);
  return created;
}

function settle(store: Db, id: string, outcome: RepositoryCommandOutcome) {
  const settled = waiter(store, id);
  settled.resolve(outcome);
  setTimeout(() => {
    if (waitersOf(store).get(id) === settled) waitersOf(store).delete(id);
  }, SETTLED_RETENTION_MS).unref();
}

function parse(payload: string): RunnerRepositoryCommand {
  const command = RunnerCommandSchema.parse(JSON.parse(payload));
  if (command.type !== "rebase") throw new Error("Repository command payload is invalid.");
  return command;
}

async function expireDue(store: Db, at: number) {
  for (const id of await store.run((q) => expireDueRepositoryCommandsSteps(q, at)))
    settle(store, id, { outcome: "expired" });
}

function* activeRunnerSteps(q: Q, runnerId: string, workspace: string): Steps<boolean> {
  const runner = yield* usableRunnerSteps(q, runnerId);
  return runner?.workspaceId === workspace && runner.status === "active";
}

function* itemMatchesSteps(q: Q, command: RunnerRepositoryCommand): Steps<boolean> {
  const item = yield* getWorkItemSteps(q, command.itemId);
  const repository = yield* getWorkItemRepositorySteps(q, command.itemId);
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

export async function enqueueRepositoryCommand(
  store: Db,
  input: RepositoryCommandInput,
): Promise<string> {
  const { now, ...fields } = input;
  const at = now ?? Date.now();
  const command = parse(
    JSON.stringify({ ...fields, id: workspaceId(at), type: "rebase", issuedAt: at }),
  );
  return store.transaction(function* (q) {
    if (!(yield* activeRunnerSteps(q, command.runnerId, command.workspaceId)))
      throw new RepositoryCommandDeniedError("Runner is not accepting repository commands.");
    const version = yield* runnerHostVersionSteps(q, command.runnerId);
    if (!runnerReleaseAtLeast(version, REPOSITORY_COMMAND_RUNNER_VERSION))
      throw new RepositoryCommandDeniedError(
        `Repository commands need runner ${REPOSITORY_COMMAND_RUNNER_VERSION.join(".")} or later.`,
      );
    if (!(yield* itemMatchesSteps(q, command)))
      throw new RepositoryCommandDeniedError("Repository command does not match its work item.");
    const { title: _title, ...untitled } = command;
    yield* insertRepositoryCommandSteps(q, {
      id: command.id,
      runnerId: command.runnerId,
      itemId: command.itemId,
      payload: JSON.stringify(
        runnerReleaseAtLeast(version, SQUASH_REBASE_RUNNER_VERSION) ? command : untitled,
      ),
      expiresAt: command.expiresAt,
      createdAt: at,
    });
    waiter(store, command.id);
    setTimeout(
      () =>
        void store
          .run((later) => expireRepositoryCommandSteps(later, command.id))
          .then(
            (state) => {
              if (state !== "done") settle(store, command.id, { outcome: "expired" });
            },
            (error: unknown) => {
              journalCaught(error, "runner-repository-commands.enqueue.expire", null);
              settle(store, command.id, { outcome: "expired" });
            },
          ),
      Math.max(0, command.expiresAt - at),
    ).unref();
    return command.id;
  });
}

export async function waitForRepositoryCommand(
  store: Db,
  id: string,
  signal?: AbortSignal,
): Promise<RepositoryCommandOutcome> {
  signal?.throwIfAborted();
  const local = waitersOf(store).get(id);
  const done = new AbortController();
  const stop = signal ? AbortSignal.any([signal, done.signal]) : done.signal;
  try {
    const polled = poll(store, id, stop);
    return await Promise.race(local ? [local.promise, polled] : [polled]);
  } finally {
    done.abort();
  }
}

async function poll(store: Db, id: string, signal: AbortSignal) {
  for (;;) {
    const row = await store.run((q) => repositoryCommandSettlementSteps(q, id, Date.now()));
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

export async function deliverRepositoryCommands(
  store: Db,
  runnerId: string,
  at: number,
  limit: number,
): Promise<RunnerRepositoryCommand[]> {
  if (limit <= 0) return [];
  await expireDue(store, at);
  return store.transaction(function* (q) {
    const rows = yield* pendingRepositoryCommandsSteps(q, runnerId, at, limit);
    for (const row of rows) yield* markRepositoryCommandDeliveredSteps(q, row.id, at);
    return rows.map((row) => parse(row.payload));
  });
}

function* currentSteps(q: Q, runnerId: string, commandId: string, at: number) {
  const row = yield* repositoryCommandRowSteps(q, commandId);
  if (!row || row.runnerId !== runnerId || row.state !== "delivered" || row.expiresAt <= at)
    throw new RepositoryCommandDeniedError("Repository command is not current.");
  const command = parse(row.payload);
  if (
    !(yield* activeRunnerSteps(q, runnerId, command.workspaceId)) ||
    !(yield* itemMatchesSteps(q, command))
  )
    throw new RepositoryCommandDeniedError("Repository command is not current.");
  return { row, command };
}

export async function issueRepositoryCommandGrant(
  store: Db,
  input: { runnerId: string; commandId: string },
  at: number,
) {
  await expireDue(store, at);
  return store.transaction(function* (q) {
    const { command } = yield* currentSteps(q, input.runnerId, input.commandId, at);
    const token = workspaceSecret();
    const expiresAt = Math.min(command.expiresAt, at + REPOSITORY_COMMAND_GRANT_MS);
    yield* setRepositoryCommandGrantSteps(q, command.id, workspaceTokenHash(token), expiresAt);
    return { token, expiresAt };
  });
}

export async function authorizeRepositoryCommand(
  store: Db,
  input: { runnerId: string; commandId: string; token: string },
  at: number,
): Promise<RunnerRepositoryCommand> {
  await expireDue(store, at);
  return store.transaction(function* (q) {
    const { row, command } = yield* currentSteps(q, input.runnerId, input.commandId, at);
    if (
      row.grantHash === null ||
      row.grantHash !== workspaceTokenHash(input.token) ||
      (row.grantExpiresAt ?? 0) <= at
    )
      throw new RepositoryCommandDeniedError("Repository command grant is invalid or expired.");
    return command;
  });
}

export async function recordRepositoryCommandResult(
  store: Db,
  input: { runnerId: string; commandId: string; result: RunnerRepositoryCommandResult },
  at: number,
) {
  const result = RunnerRepositoryCommandResultSchema.parse(input.result);
  const stored = JSON.stringify(result);
  await expireDue(store, at);
  const recorded = await store.transaction(function* (q) {
    const row = yield* repositoryCommandRowSteps(q, input.commandId);
    if (!row || row.runnerId !== input.runnerId)
      throw new RepositoryCommandDeniedError("Repository command is unknown.");
    if (row.state === "done") {
      if (row.result !== stored)
        throw new RepositoryCommandDeniedError("Repository command already has another result.");
      return false;
    }
    if (row.state !== "delivered" || row.expiresAt <= at)
      throw new RepositoryCommandDeniedError("Repository command is not current.");
    yield* completeRepositoryCommandSteps(q, row.id, stored, at);
    return true;
  });
  if (recorded) settle(store, input.commandId, result);
  return { duplicate: !recorded };
}

export function repositoryCommandDeliveredToSteps(q: Q, runnerId: string, id: string) {
  return repositoryCommandReachedRunnerSteps(q, id, runnerId);
}

export async function repositoryCommandState(store: Db, id: string, at = Date.now()) {
  await expireDue(store, at);
  return (await store.run((q) => repositoryCommandRowSteps(q, id)))?.state ?? null;
}

async function cancelRepositoryCommand(store: Db, id: string) {
  if (await store.run((q) => cancelOpenRepositoryCommandSteps(q, id)))
    settle(store, id, { outcome: "expired" });
}

const REPOSITORY_REBASE_TIMEOUT_MS = 10 * 60_000;

export async function rebaseOnRunner(
  store: Db,
  input: Omit<RepositoryCommandInput, "expiresAt" | "now"> & { now: number },
  signal?: AbortSignal,
): Promise<RunnerRepositoryCommandResult> {
  try {
    signal?.throwIfAborted();
    const id = await enqueueRepositoryCommand(store, {
      ...input,
      expiresAt: input.now + REPOSITORY_REBASE_TIMEOUT_MS,
    });
    const outcome = await waitForRepositoryCommand(store, id, signal).catch(
      async (error: unknown) => {
        await cancelRepositoryCommand(store, id);
        throw error;
      },
    );
    return outcome.outcome === "expired"
      ? { outcome: "failed", reason: "timed out after 10 minutes" }
      : outcome;
  } catch (error) {
    if (!(error instanceof RepositoryCommandDeniedError)) throw error;
    return { outcome: "failed", reason: error.message };
  }
}
