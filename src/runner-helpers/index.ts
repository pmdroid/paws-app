import { journalCaught } from "../journal";
import { randomUUID, type KeyObject } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  getLinearSession,
  immediate,
  runnerCancelPending,
  runnerHasCapacity,
  workspaceSessionIds,
  workspaceMember,
} from "../db";
import {
  RunnerCommandSchema,
  RunnerHelperResultSchema,
  RUNNER_RESULT_BODY_LIMIT,
  signRunnerCommand,
  type RunnerCommand,
  type RunnerHelperResult,
  type RunnerProfile,
  type SignedRunnerCommand,
} from "../runner-protocol";
import { runnerRequestUnavailable } from "../runner-work";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;
type Row = {
  runnerId: string;
  workspaceId: string;
  runnerFence: number;
  envelope: string;
  endedAt: number | null;
  result: string | null;
};
class HelperFencedError extends Error {}

export function createRunnerHelpers(options: {
  db: Database;
  keyId: string;
  privateKey: KeyObject;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function identity(runnerId: string) {
    const row = db
      .query<{ workspaceId: string; userId: string; fence: number; status: string }, [string]>(
        "SELECT r.workspace_id AS workspaceId,r.owner_user_id AS userId,r.fence,r.status FROM runner r JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id WHERE r.id=? AND r.revoked_at IS NULL AND r.status<>'revoked' AND m.active=1",
      )
      .get(runnerId);
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
    const installation = db
      .query<{ clientId: string | null }, [string]>(
        "SELECT oauth_client_id AS clientId FROM linear_session WHERE session_id=?",
      )
      .get(sessionId);
    const grouping = purpose === "finding_groups";
    const member = grouping ? workspaceMember(db, runner.workspaceId, runner.userId) : null;
    if (
      (grouping && (!member?.active || !["admin", "owner"].includes(member.role))) ||
      !session ||
      (!grouping && session.stoppedAt !== null) ||
      session.generation !== generation ||
      !installation?.clientId ||
      !workspaceSessionIds(db, runner.workspaceId, runner.userId, installation.clientId).includes(
        sessionId,
      )
    )
      throw new HelperFencedError("Linear helper session authority changed");
    return runner;
  }
  function current(id: string, runnerId?: string) {
    const row = db
      .query<Row, [string]>(
        "SELECT runner_id AS runnerId,workspace_id AS workspaceId,runner_fence AS runnerFence,envelope,ended_at AS endedAt,result FROM runner_helper WHERE id=?",
      )
      .get(id);
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
    }) {
      return immediate(db, () => {
        const session = getLinearSession(db, input.sessionId);
        if (!session) throw new HelperFencedError("Linear helper session is unavailable");
        const runner = scope(input.runnerId, input.sessionId, session.generation, input.purpose);
        if (runner.status !== "active") throw new Error("Runner is not accepting helper work");
        if (runnerCancelPending(db, input.runnerId, now()))
          throw new Error("Runner cancellation teardown is still pending");
        if (
          db
            .query(
              "SELECT 1 FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>? LIMIT 1",
            )
            .get(input.runnerId, now()) ||
          !runnerHasCapacity(db, input.runnerId, now())
        )
          throw new Error("Runner is busy");
        const at = now();
        const command = RunnerCommandSchema.parse({
          ...input,
          id: randomUUID(),
          type: "helper",
          workspaceId: runner.workspaceId,
          sessionGeneration: session.generation,
          issuedAt: at,
          expiresAt: at + (input.purpose === "finding_groups" ? 600_000 : 60_000),
        }) as HelperCommand;
        const envelope = signRunnerCommand({
          keyId: options.keyId,
          privateKey: options.privateKey,
          command,
        });
        db.run(
          "INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,envelope,expires_at) VALUES(?,?,?,?,?,?,?,?)",
          [
            command.id,
            command.runnerId,
            command.workspaceId,
            command.sessionId,
            command.sessionGeneration,
            runner.fence,
            JSON.stringify(envelope),
            command.expiresAt,
          ],
        );
        return { command, envelope };
      });
    },
    commands(runnerId: string) {
      identity(runnerId);
      const result: SignedRunnerCommand[] = [];
      const rows = db
        .query<{ id: string }, [string, number]>(
          "SELECT id FROM runner_helper WHERE runner_id=? AND acknowledged_at IS NULL AND ended_at IS NULL AND expires_at>? ORDER BY rowid",
        )
        .all(runnerId, now());
      for (const row of rows) {
        try {
          result.push(current(row.id, runnerId).envelope);
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
        db.run("UPDATE runner_helper SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?", [
          now(),
          id,
        ]);
      });
    },
    submit(runnerId: string, result: RunnerHelperResult) {
      const parsed = RunnerHelperResultSchema.parse(result);
      return immediate(db, () => {
        const { row } = current(parsed.commandId, runnerId);
        const payload = JSON.stringify(parsed);
        if (row.result !== null) {
          if (row.result !== payload) throw new Error("Runner helper result is immutable");
          return { duplicate: true };
        }
        db.run("UPDATE runner_helper SET result=? WHERE id=?", [payload, parsed.commandId]);
        return { duplicate: false };
      });
    },
    result(id: string): RunnerHelperResult | null {
      const { row } = current(id);
      return row.result === null ? null : RunnerHelperResultSchema.parse(JSON.parse(row.result));
    },
    finish(id: string) {
      db.run("UPDATE runner_helper SET ended_at=COALESCE(ended_at,?) WHERE id=?", [now(), id]);
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
