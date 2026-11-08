import {
  acknowledgeRunnerHelper,
  endRunnerHelper,
  workspaceMemberUsable,
  getLinearSession,
  immediate,
  insertRunnerHelper,
  linearSessionClientId,
  recordCommandAccount,
  runnerHelperAvailability,
  runnerHelperResultMatches,
  runnerHelperRow,
  storeRunnerHelperResult,
  unacknowledgedRunnerHelpers,
  usableRunner,
  yieldFindingGroupHelpers,
  workspaceSessionIds,
  workspaceMember,
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
  type RunnerCommand,
  type RunnerHelperResult,
  type RunnerAccount,
  type RunnerProfile,
  type SignedRunnerCommand,
} from "../runner-protocol";
import { runnerRequestUnavailable } from "../runner-work";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;
class HelperFencedError extends Error {}
/** The runner's helper slot or its task slots are taken: the helper can start once one frees. */
export class RunnerHelperBusyError extends Error {
  override readonly name = "RunnerHelperBusyError";
  constructor() {
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
  const now = options.now ?? Date.now;
  function identity(runnerId: string) {
    const row = usableRunner(db, runnerId);
    if (!row) throw new HelperFencedError("Runner helper identity is unavailable");
    return row;
  }
  function scope(
    runnerId: string,
    sessionId: string,
    generation: number,
    purpose?: HelperCommand["purpose"],
  ) {
    const runner = identity(runnerId);
    const session = getLinearSession(db, sessionId);
    const clientId = linearSessionClientId(db, sessionId);
    const grouping = purpose === "finding_groups";
    const member = grouping ? workspaceMember(db, runner.workspaceId, runner.userId) : null;
    if (
      (grouping && (!workspaceMemberUsable(member) || !["admin", "owner"].includes(member.role))) ||
      !session ||
      (!grouping && session.stoppedAt !== null) ||
      session.generation !== generation ||
      !clientId ||
      !workspaceSessionIds(db, runner.workspaceId, runner.userId, clientId).includes(sessionId)
    )
      throw new HelperFencedError("Linear helper session authority changed");
    return runner;
  }
  function current(id: string, runnerId?: string) {
    const row = runnerHelperRow(db, id);
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
    const runner = scope(
      row.runnerId,
      command.sessionId,
      command.sessionGeneration,
      command.purpose,
    );
    if (runner.fence !== row.runnerFence || runner.workspaceId !== row.workspaceId)
      throw new HelperFencedError("Runner helper identity changed");
    return { row, command, envelope };
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
      return immediate(db, () => {
        const session = getLinearSession(db, input.sessionId);
        if (!session) throw new HelperFencedError("Linear helper session is unavailable");
        const runner = scope(input.runnerId, input.sessionId, session.generation, input.purpose);
        if (runner.status !== "active") throw new Error("Runner is not accepting helper work");
        const conversation = input.purpose === "conversation";
        if (
          !runnerHelperAvailability(
            db,
            input.runnerId,
            now(),
            input.purpose !== "finding_groups",
            conversation,
          ).available
        )
          throw new RunnerHelperBusyError();
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
        recordCommandAccount(db, command, at);
        if (input.purpose !== "finding_groups" && !conversation)
          yieldFindingGroupHelpers(db, input.runnerId, at);
        insertRunnerHelper(db, {
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
    commands(runnerId: string) {
      identity(runnerId);
      const result: SignedRunnerCommand[] = [];
      const ids = unacknowledgedRunnerHelpers(db, runnerId, now());
      for (const id of ids) {
        try {
          result.push(current(id, runnerId).envelope);
        } catch (error) {
          if (!(error instanceof HelperFencedError)) throw error;
          journalCaught(error, "runner-helpers.commands.push", null);
        }
        if (result.length === 16) break;
      }
      return result;
    },
    current,
    acknowledge(runnerId: string, id: string) {
      immediate(db, () => {
        current(id, runnerId);
        acknowledgeRunnerHelper(db, id, now());
      });
    },
    submit(runnerId: string, result: RunnerHelperResult) {
      const parsed = RunnerHelperResultSchema.parse(result);
      return immediate(db, () => {
        const { row, command } = current(parsed.commandId, runnerId);
        if (!runnerAccountEchoed(command, parsed))
          throw new Error("Runner helper result account does not match its command");
        const payload = JSON.stringify(parsed);
        if (row.result !== null) {
          if (!runnerHelperResultMatches(db, parsed.commandId, payload))
            throw new Error("Runner helper result is immutable");
          return { duplicate: true };
        }
        storeRunnerHelperResult(db, parsed.commandId, payload);
        return { duplicate: false };
      });
    },
    result(id: string): RunnerHelperResult | null {
      const { row } = current(id);
      return row.result === null ? null : RunnerHelperResultSchema.parse(JSON.parse(row.result));
    },
    finish(id: string) {
      endRunnerHelper(db, id, now());
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "cache-control": "no-store" } });
      try {
        if (path === "/v1/helper-commands" && request.method === "GET")
          return json({ commands: api.commands(runnerId) });
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
          return json(api.submit(runnerId, result));
        }
        z.strictObject({}).parse(input);
        if (match[2] === "ack") {
          api.acknowledge(runnerId, id);
          return json({ ok: true });
        }
        return json({ expiresAt: current(id, runnerId).command.expiresAt });
      } catch (error) {
        journalCaught(error, "runner-helpers.fetch.json", null);
        if (error instanceof HelperFencedError)
          return json({ error: "Runner helper is fenced.", code: "fenced" }, 409);
        if (runnerRequestUnavailable(error))
          return json({ error: "Paws is busy. Retry the request." }, 503);
        return json({ error: "Runner helper request is denied or invalid." }, 403);
      }
    },
  };
  return api;
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
