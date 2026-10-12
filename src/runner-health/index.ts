import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { auditWorkspaceAccess, getRunner, immediate, workspaceMember } from "../db";
import type { WorkspacePrincipal } from "../workspace";
import type { RunnerWork } from "../runner-work";
import {
  RunnerCommandSchema,
  RunnerHealthResultSchema,
  RunnerProfileSchema,
  type RunnerHealthResult,
} from "../runner-protocol";

const requestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("probe"), profile: RunnerProfileSchema }),
  z.strictObject({ type: z.literal("login_check"), agent: z.enum(["claude", "codex", "grok"]) }),
]);
type HealthRequest = z.infer<typeof requestSchema>;

export function createRunnerHealth(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  function visible(principal: WorkspacePrincipal, runnerId: string) {
    const member = workspaceMember(db, principal.workspaceId, principal.userId);
    const runner = getRunner(db, runnerId);
    if (!member?.active || runner?.workspaceId !== principal.workspaceId)
      throw new Error("Runner access denied");
    return { member, runner };
  }
  function command(commandId: string, runnerId: string) {
    const row = db
      .query<{ envelope: string }, [string, string]>(
        "SELECT envelope FROM runner_command WHERE id=? AND runner_id=? AND kind IN ('probe','login_check')",
      )
      .get(commandId, runnerId);
    if (!row) throw new Error("Runner health command is unavailable");
    const envelope = JSON.parse(row.envelope) as { payload: string };
    const value = RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    );
    if (
      (value.type !== "probe" && value.type !== "login_check") ||
      value.id !== commandId ||
      value.runnerId !== runnerId
    )
      throw new Error("Runner health command binding changed");
    return value;
  }
  const api = {
    request(principal: WorkspacePrincipal, runnerId: string, input: HealthRequest) {
      const parsed = requestSchema.parse(input);
      return immediate(db, () => {
        const at = now();
        const { member, runner } = visible(principal, runnerId);
        if (
          !["owner", "admin"].includes(member.role) ||
          principal.authenticatedAt > at ||
          at - principal.authenticatedAt > 15 * 60_000
        )
          throw new Error("Sign in again as a workspace administrator");
        const pending = db
          .query<{ count: number }, [string, number]>(
            "SELECT COUNT(*) AS count FROM runner_command c LEFT JOIN runner_health_result h ON h.command_id=c.id WHERE c.runner_id=? AND c.kind IN ('probe','login_check') AND c.expires_at>? AND h.command_id IS NULL",
          )
          .get(runnerId, at)!.count;
        if (pending >= 4) throw new Error("Runner health checks are already pending");
        const commandId = randomUUID();
        const expiresAt = at + 120_000;
        work.enqueue({
          id: commandId,
          runnerId,
          workspaceId: runner.workspaceId,
          issuedAt: at,
          expiresAt,
          ...parsed,
        });
        auditWorkspaceAccess(db, {
          workspaceId: runner.workspaceId,
          userId: principal.userId,
          action: `runner.${parsed.type}`,
          subject: runnerId,
          now: at,
        });
        return { commandId, expiresAt };
      });
    },
    submit(runnerId: string, input: RunnerHealthResult) {
      const result = RunnerHealthResultSchema.parse(input);
      return immediate(db, () => {
        const runner = getRunner(db, runnerId);
        if (
          !runner ||
          runner.status === "revoked" ||
          !workspaceMember(db, runner.workspaceId, runner.ownerUserId)?.active
        )
          throw new Error("Runner identity is unavailable");
        const assigned = command(result.commandId, runnerId);
        const at = now();
        if (
          assigned.workspaceId !== runner.workspaceId ||
          assigned.issuedAt > at ||
          assigned.expiresAt <= at
        )
          throw new Error("Runner health command has expired");
        if (
          (assigned.type === "probe" && result.login !== undefined) ||
          (assigned.type === "login_check" &&
            (!result.login || result.login.agent !== assigned.agent)) ||
          (result.login?.authenticated &&
            (result.authRequired ||
              result.cancelled ||
              result.timedOut ||
              !result.agentExited ||
              result.errorMessage !== undefined ||
              result.stopReason !== "end_turn")) ||
          (result.login && result.login.authenticated === (result.login.method === "none"))
        )
          throw new Error("Runner health result contradicts its command");
        const value = JSON.stringify(result);
        const previous = db
          .query<{ result_json: string }, [string]>(
            "SELECT result_json FROM runner_health_result WHERE command_id=?",
          )
          .get(result.commandId);
        if (previous) {
          if (previous.result_json !== value) throw new Error("Runner health result changed");
          return { duplicate: true };
        }
        db.run("INSERT INTO runner_health_result VALUES(?,?,?,?)", [
          result.commandId,
          runnerId,
          value,
          at,
        ]);
        db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [at, runnerId]);
        return { duplicate: false };
      });
    },
    read(runnerId: string, commandId: string) {
      const runner = getRunner(db, runnerId);
      if (
        !runner ||
        runner.status === "revoked" ||
        !workspaceMember(db, runner.workspaceId, runner.ownerUserId)?.active
      )
        throw new Error("Runner identity is unavailable");
      if (command(commandId, runnerId).expiresAt <= now())
        throw new Error("Runner health command has expired");
      const row = db
        .query<{ result_json: string }, [string, string]>(
          "SELECT result_json FROM runner_health_result WHERE runner_id=? AND command_id=?",
        )
        .get(runnerId, commandId);
      return row ? RunnerHealthResultSchema.parse(JSON.parse(row.result_json)) : null;
    },
    list(principal: WorkspacePrincipal, runnerId: string) {
      visible(principal, runnerId);
      const checks = db
        .query<
          { id: string; expiresAt: number; receivedAt: number | null; resultJson: string | null },
          [string]
        >(
          "SELECT c.id,c.expires_at AS expiresAt,h.received_at AS receivedAt,h.result_json AS resultJson FROM runner_command c LEFT JOIN runner_health_result h ON h.command_id=c.id WHERE c.runner_id=? AND c.kind IN ('probe','login_check') ORDER BY c.rowid DESC LIMIT 12",
        )
        .all(runnerId)
        .map((row) => ({
          command: command(row.id, runnerId),
          expiresAt: row.expiresAt,
          receivedAt: row.receivedAt,
          result: row.resultJson
            ? RunnerHealthResultSchema.parse(JSON.parse(row.resultJson))
            : null,
        }));
      const lastSeenAt = db
        .query<{ lastSeenAt: number | null }, [string]>(
          "SELECT last_seen_at AS lastSeenAt FROM runner WHERE id=?",
        )
        .get(runnerId)!.lastSeenAt;
      return { lastSeenAt, checks };
    },
    async browser(request: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const match = /^\/api\/runners\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/health$/.exec(
        new URL(request.url).pathname,
      );
      if (!match) return null;
      try {
        if (request.method === "GET") return json(api.list(principal, match[1]!));
        if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        return json(api.request(principal, match[1]!, requestSchema.parse(await body(request))));
      } catch {
        return json({ error: "Runner health request is unavailable." }, 403);
      }
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      if (new URL(request.url).pathname !== "/v1/health") return null;
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      try {
        return json(api.submit(runnerId, RunnerHealthResultSchema.parse(await body(request))));
      } catch {
        return json({ error: "Runner health result was rejected." }, 403);
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
  const cancel = () => void reader.cancel().catch(() => undefined);
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
      if (bytes > 131_072) throw new Error("Runner health payload exceeds limit");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export type RunnerHealth = ReturnType<typeof createRunnerHealth>;
