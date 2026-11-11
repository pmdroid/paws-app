import {
  acknowledgeRunnerHelperSteps,
  endRunnerHelperSteps,
  workspaceMemberUsable,
  getLinearSessionSteps,
  insertRunnerHelperSteps,
  linearSessionClientIdSteps,
  openSessionHelperSteps,
  recordCommandAccountSteps,
  runnerHelperAcknowledgedSteps,
  runnerHelperAvailabilitySteps,
  runnerHelperResultMatchesSteps,
  runnerHelperRowSteps,
  settled,
  sqliteDb,
  storeRunnerHelperResultSteps,
  unacknowledgedRunnerHelpersSteps,
  usableRunnerSteps,
  yieldFindingGroupHelpersSteps,
  workspaceSessionIdsSteps,
  workspaceMemberSteps,
  type Q,
  type RunnerHelperRow,
  type Steps,
  type UsableRunner,
} from "../db";
import { journalCaught } from "../journal";
import { randomUUID, type KeyObject } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  RunnerCommandSchema,
  RunnerHelperResultSchema,
  RUNNER_RESULT_BODY_LIMIT,
  runnerHelperLifetime,
  runnerAccountEchoed,
  signRunnerCommand,
  withRejectedFields,
  type RunnerCommand,
  type RunnerHelperResult,
  type RunnerAccount,
  type RunnerProfile,
  type SignedRunnerCommand,
} from "../runner-protocol";
import { runnerRequestUnavailable } from "../runner-work";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;
class HelperFencedError extends Error {}
export class RunnerHelperBusyError extends Error {
  override readonly name = "RunnerHelperBusyError";
  constructor(readonly heldRunnerId?: string) {
    super("Runner is busy");
  }
}

export function createRunnerHelpers(options: {
  db: Database;
  keyId: string;
  privateKey: KeyObject;
  now?: () => number;
}) {
  const { db } = options;
  const store = sqliteDb(db);
  const transaction = <T>(steps: (q: Q) => Steps<T>) => settled(store.transaction(steps));
  const now = options.now ?? Date.now;
  function* identitySteps(q: Q, runnerId: string) {
    return identified(yield* usableRunnerSteps(q, runnerId));
  }
  function* scopeSteps(
    q: Q,
    runnerId: string,
    sessionId: string,
    generation: number,
    purpose?: HelperCommand["purpose"],
  ) {
    const runner = yield* identitySteps(q, runnerId);
    const session = yield* getLinearSessionSteps(q, sessionId);
    const clientId = yield* linearSessionClientIdSteps(q, sessionId);
    const grouping = purpose === "finding_groups";
    const member = grouping
      ? yield* workspaceMemberSteps(q, runner.workspaceId, runner.userId)
      : null;
    if (
      !sessionHeld(grouping, member, session, generation, clientId) ||
      !(yield* workspaceSessionIdsSteps(q, runner.workspaceId, runner.userId, clientId)).includes(
        sessionId,
      )
    )
      throw new HelperFencedError("Linear helper session authority changed");
    return runner;
  }
  function* currentSteps(q: Q, id: string, runnerId?: string) {
    const { row, command, envelope } = assigned(yield* runnerHelperRowSteps(q, id), id, runnerId);
    const runner = yield* scopeSteps(
      q,
      row.runnerId,
      command.sessionId,
      command.sessionGeneration,
      command.purpose,
    );
    return { row: unchangedIdentity(runner, row), command, envelope };
  }
  function assigned(row: RunnerHelperRow | null, id: string, runnerId?: string) {
    if (!row || (runnerId !== undefined && row.runnerId !== runnerId) || row.endedAt !== null)
      throw new HelperFencedError("Runner helper assignment is unavailable");
    const envelope = JSON.parse(row.envelope) as SignedRunnerCommand;
    const command = RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    );
    if (
      command.type !== "helper" ||
      command.id !== id ||
      command.runnerId !== row.runnerId ||
      command.workspaceId !== row.workspaceId ||
      command.issuedAt > now() ||
      command.expiresAt <= now()
    )
      throw new HelperFencedError("Runner helper command is obsolete");
    return { row, command, envelope };
  }
  function* openSteps(q: Q, sessionId: string): Steps<HelperCommand | null> {
    const session = yield* getLinearSessionSteps(q, sessionId);
    const row = session && (yield* openSessionHelperSteps(q, sessionId, session.generation, now()));
    if (!row) return null;
    try {
      return (yield* currentSteps(q, row.id)).command;
    } catch (error) {
      if (error instanceof HelperFencedError) return null;
      throw error;
    }
  }
  const api = {
    dispatch(input: {
      runnerId: string;
      sessionId: string;
      purpose: HelperCommand["purpose"];
      profile: RunnerProfile;
      prompt: string;
      account?: RunnerAccount;
      conversation?: HelperCommand["conversation"];
    }) {
      return transaction(function* (q) {
        const session = yield* getLinearSessionSteps(q, input.sessionId);
        if (!session) throw new HelperFencedError("Linear helper session is unavailable");
        const runner = yield* scopeSteps(
          q,
          input.runnerId,
          input.sessionId,
          session.generation,
          input.purpose,
        );
        if (runner.status !== "active") throw new Error("Runner is not accepting helper work");
        const conversation = input.purpose === "conversation";
        if (input.purpose === "classify" || input.purpose === "select_repository") {
          const open = yield* openSteps(q, input.sessionId);
          if (open) throw new RunnerHelperBusyError(open.runnerId);
        }
        const availability = yield* runnerHelperAvailabilitySteps(
          q,
          input.runnerId,
          now(),
          input.purpose !== "finding_groups",
          conversation,
        );
        if (availability.held) throw new RunnerHelperBusyError(input.runnerId);
        if (!availability.available) throw new RunnerHelperBusyError();
        const at = now();
        const command = RunnerCommandSchema.parse({
          ...input,
          id: randomUUID(),
          type: "helper",
          workspaceId: runner.workspaceId,
          sessionGeneration: session.generation,
          issuedAt: at,
          expiresAt: at + runnerHelperLifetime(input.purpose),
        }) as HelperCommand;
        const envelope = signRunnerCommand({
          keyId: options.keyId,
          privateKey: options.privateKey,
          command,
        });
        // Validate and sign first. Fencing and admission commit together, only on this runner.
        yield* recordCommandAccountSteps(q, command, at);
        if (input.purpose !== "finding_groups" && !conversation)
          yield* yieldFindingGroupHelpersSteps(q, input.runnerId, at);
        yield* insertRunnerHelperSteps(q, {
          id: command.id,
          runnerId: command.runnerId,
          workspaceId: command.workspaceId,
          sessionId: command.sessionId,
          sessionGeneration: command.sessionGeneration,
          runnerFence: runner.fence,
          envelope: JSON.stringify(envelope),
          expiresAt: command.expiresAt,
          purpose: command.purpose,
        });
        return { command, envelope };
      });
    },
    commands(runnerId: string): Promise<SignedRunnerCommand[]> {
      return store.run(function* (q) {
        yield* identitySteps(q, runnerId);
        const result: SignedRunnerCommand[] = [];
        const ids = yield* unacknowledgedRunnerHelpersSteps(q, runnerId, now());
        for (const id of ids) {
          try {
            result.push((yield* currentSteps(q, id, runnerId)).envelope);
          } catch (error) {
            if (!(error instanceof HelperFencedError)) throw error;
            journalCaught(error, "runner-helpers.commands.push", null);
          }
          if (result.length === 16) break;
        }
        return result;
      });
    },
    current: (id: string, runnerId?: string) => store.run((q) => currentSteps(q, id, runnerId)),
    open(sessionId: string): HelperCommand | null {
      return settled(store.run((q) => openSteps(q, sessionId)));
    },
    acknowledged: (id: string) => store.run((q) => runnerHelperAcknowledgedSteps(q, id)),
    async acknowledge(runnerId: string, id: string): Promise<void> {
      await store.transaction(function* (q) {
        yield* currentSteps(q, id, runnerId);
        yield* acknowledgeRunnerHelperSteps(q, id, now());
      });
    },
    async submit(runnerId: string, result: RunnerHelperResult) {
      const parsed = RunnerHelperResultSchema.parse(result);
      return store.transaction(function* (q) {
        const { row, command } = yield* currentSteps(q, parsed.commandId, runnerId);
        if (!runnerAccountEchoed(command, parsed))
          throw new Error("Runner helper result account does not match its command");
        const payload = JSON.stringify(parsed);
        if (row.result !== null) {
          if (!(yield* runnerHelperResultMatchesSteps(q, parsed.commandId, payload)))
            throw new Error("Runner helper result is immutable");
          return { duplicate: true };
        }
        yield* storeRunnerHelperResultSteps(q, parsed.commandId, payload);
        return { duplicate: false };
      });
    },
    async result(id: string): Promise<RunnerHelperResult | null> {
      const { row } = await store.run((q) => currentSteps(q, id));
      return row.result === null ? null : RunnerHelperResultSchema.parse(JSON.parse(row.result));
    },
    finish(id: string) {
      settled(store.run((q) => endRunnerHelperSteps(q, id, now())));
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "cache-control": "no-store" } });
      try {
        if (path === "/v1/helper-commands" && request.method === "GET")
          return json({ commands: await api.commands(runnerId) });
        const match = /^\/v1\/helper-commands\/([^/]+)\/(ack|lease|result)$/.exec(path);
        if (!match || request.method !== "POST") return null;
        const id = z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
          .parse(decodeURIComponent(match[1]!));
        const input = await body(request);
        if (match[2] === "result") {
          const result = RunnerHelperResultSchema.parse(input);
          if (result.commandId !== id) throw new Error("Runner helper result command changed");
          return json(await api.submit(runnerId, result));
        }
        z.strictObject({}).parse(input);
        if (match[2] === "ack") {
          await api.acknowledge(runnerId, id);
          return json({ ok: true });
        }
        return json({ expiresAt: (await api.current(id, runnerId)).command.expiresAt });
      } catch (error) {
        journalCaught(error, "runner-helpers.fetch.json", null);
        if (error instanceof HelperFencedError)
          return json({ error: "Runner helper is fenced.", code: "fenced" }, 409);
        if (runnerRequestUnavailable(error))
          return json({ error: "Paws is busy. Retry the request." }, 503);
        const denied = json({ error: "Runner helper request is denied or invalid." }, 403);
        return withRejectedFields(denied, error);
      }
    },
  };
  return api;
}

function identified(row: UsableRunner | null): UsableRunner {
  if (!row) throw new HelperFencedError("Runner helper identity is unavailable");
  return row;
}

/** Whether the session still admits a helper, short of the workspace's session list. */
function sessionHeld(
  grouping: boolean,
  member: { active: boolean | number; revokedAt: number | null; role: string } | null,
  session: { stoppedAt: number | null; generation: number } | null,
  generation: number,
  clientId: string | null,
): clientId is string {
  return !(
    (grouping && (!workspaceMemberUsable(member) || !["admin", "owner"].includes(member.role))) ||
    !session ||
    (!grouping && session.stoppedAt !== null) ||
    session.generation !== generation ||
    !clientId
  );
}

function unchangedIdentity(runner: UsableRunner, row: RunnerHelperRow): RunnerHelperRow {
  if (runner.fence !== row.runnerFence || runner.workspaceId !== row.workspaceId)
    throw new HelperFencedError("Runner helper identity changed");
  return row;
}

async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () =>
    void reader.cancel().catch((caughtError1) => {
      journalCaught(caughtError1, "runner-helpers.body.cancel", null);
      return undefined;
    });
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RUNNER_RESULT_BODY_LIMIT) throw new Error("Runner helper input is too large");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "runner-helpers.body.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}

export type RunnerHelpers = ReturnType<typeof createRunnerHelpers>;
