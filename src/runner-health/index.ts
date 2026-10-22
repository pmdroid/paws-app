import { authorizeRunnerAccount } from "../runner-accounts";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  auditWorkspaceAccess,
  getRunner,
  immediate,
  recordRunnerAgentUsage,
  runnerAgentUsage,
  workspaceMember,
  type RunnerAgentLimit,
} from "../db";
import type { WorkspacePrincipal } from "../workspace";
import type { RunnerWork } from "../runner-work";
import {
  RunnerCommandSchema,
  RUNNER_RESULT_BODY_LIMIT,
  RunnerHealthResultSchema,
  RunnerProfileSchema,
  type RunnerHealthResult,
} from "../runner-protocol";

const requestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("probe"), profile: RunnerProfileSchema }),
  z.strictObject({ type: z.literal("login_check"), agent: z.enum(["claude", "codex", "grok"]) }),
]);
type HealthRequest = z.infer<typeof requestSchema>;
type Agent = "claude" | "codex" | "grok";
export type AgentSignIn = {
  agent: Agent;
  status: "signed_in" | "signed_out" | "checking" | "usage_limit" | "unknown";
  checkedAt: number | null;
  resetsAt?: number | null;
  limits?: RunnerAgentLimit[];
  limitsAt?: number;
};
type Target = { memberId?: string; agent: Agent };
type History = {
  inFlight: boolean;
  issuedAt: number;
  result: { authenticated: boolean; receivedAt: number } | null;
};
const SIGN_IN_INTERVAL_MS = 5 * 60_000;
const RECENTLY_SEEN_MS = 60_000;
const runnerAgents = ["claude", "codex", "grok"] as const;

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
  function pendingChecks(runnerId: string, at: number) {
    return db
      .query<{ count: number }, [string, number]>(
        "SELECT COUNT(*) AS count FROM runner_command c LEFT JOIN runner_health_result h ON h.command_id=c.id WHERE c.runner_id=? AND c.kind IN ('probe','login_check') AND c.expires_at>? AND h.command_id IS NULL",
      )
      .get(runnerId, at)!.count;
  }
  function memberAccounts(runnerId: string) {
    return db.query("SELECT 1 FROM runner_member_account WHERE runner_id=?").get(runnerId) !== null;
  }
  /** Latest sign-in checks per member and agent. Bounded so old command rows are not rescanned. */
  function history(runnerId: string, at: number) {
    const latest = new Map<string, History>();
    const rows = db
      .query<
        {
          id: string;
          envelope: string;
          expiresAt: number;
          receivedAt: number | null;
          resultJson: string | null;
        },
        [string]
      >(
        "SELECT c.id,c.envelope,c.expires_at AS expiresAt,h.received_at AS receivedAt,h.result_json AS resultJson FROM runner_command c LEFT JOIN runner_health_result h ON h.command_id=c.id WHERE c.runner_id=? AND c.kind='login_check' ORDER BY c.ordinal DESC LIMIT 256",
      )
      .all(runnerId);
    for (const row of rows) {
      const envelope = JSON.parse(row.envelope) as { payload: string };
      const value = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as {
        id: string;
        type: string;
        runnerId: string;
        memberId?: string;
        agent: Agent;
        issuedAt: number;
      };
      if (value.type !== "login_check" || value.id !== row.id || value.runnerId !== runnerId)
        continue;
      const key = `${value.memberId ?? ""}/${value.agent}`;
      const entry = latest.get(key) ?? { inFlight: false, issuedAt: value.issuedAt, result: null };
      latest.set(key, entry);
      if (row.resultJson === null) {
        if (row.expiresAt > at) entry.inFlight = true;
      } else if (!entry.result) {
        const login = RunnerHealthResultSchema.parse(JSON.parse(row.resultJson)).login;
        if (login)
          entry.result = { authenticated: login.authenticated, receivedAt: row.receivedAt! };
      }
    }
    return (target: Target) => latest.get(`${target.memberId ?? ""}/${target.agent}`);
  }
  function targets(runnerId: string): Target[] {
    if (!memberAccounts(runnerId)) return runnerAgents.map((agent) => ({ agent }));
    return db
      .query<{ memberId: string; agent: Agent }, [string]>(
        `SELECT a.user_id AS memberId,a.agent FROM runner_member_account a JOIN runner r ON r.id=a.runner_id
        JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=a.user_id
        LEFT JOIN runner_policy p ON p.runner_id=r.id
        WHERE a.runner_id=? AND m.active=1 AND m.role<>'observer'
        AND (a.user_id=r.owner_user_id OR COALESCE(p.sharing,0)=1) ORDER BY a.user_id,a.agent`,
      )
      .all(runnerId);
  }
  function queueCheck(runner: { id: string; workspaceId: string }, target: Target, at: number) {
    work.enqueue({
      id: randomUUID(),
      type: "login_check",
      runnerId: runner.id,
      workspaceId: runner.workspaceId,
      ...(target.memberId ? { memberId: target.memberId } : {}),
      agent: target.agent,
      issuedAt: at,
      expiresAt: at + 120_000,
    });
  }
  const api = {
    request(principal: WorkspacePrincipal, runnerId: string, input: HealthRequest) {
      const parsed = requestSchema.parse(input);
      return immediate(db, () => {
        const at = now();
        const { member, runner } = visible(principal, runnerId);
        if (!["owner", "admin"].includes(member.role))
          throw new Error("Workspace administrator access is required");
        if (pendingChecks(runnerId, at) >= 4)
          throw new Error("Runner health checks are already pending");
        const commandId = randomUUID();
        const expiresAt = at + 120_000;
        work.enqueue({
          id: commandId,
          runnerId,
          workspaceId: runner.workspaceId,
          ...(memberAccounts(runnerId) ? { memberId: principal.userId } : {}),
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
    /**
     * Queues a login_check per agent on active, recently seen runners when the last check is older
     * than five minutes and none is in flight. Never queues probe: it runs a model turn.
     */
    refresh() {
      const at = now();
      const runners = db
        .query<{ id: string; workspaceId: string }, [number]>(
          `SELECT r.id,r.workspace_id AS workspaceId FROM runner r
          JOIN workspace_member o ON o.workspace_id=r.workspace_id AND o.user_id=r.owner_user_id
          WHERE r.status='active' AND r.revoked_at IS NULL AND o.active=1 AND r.last_seen_at>?
          ORDER BY r.id`,
        )
        .all(at - RECENTLY_SEEN_MS);
      const errors: unknown[] = [];
      for (const runner of runners) {
        try {
          immediate(db, () => {
            const last = history(runner.id, at);
            const due = targets(runner.id);
            for (const target of due) {
              if (!target.memberId) continue;
              const entry = last(target);
              if (!entry?.result?.authenticated || entry.inFlight) continue;
              db.run(
                "UPDATE runner_member_account SET connected=1,updated_at=? WHERE runner_id=? AND user_id=? AND agent=? AND connected=0 AND updated_at<?",
                [at, runner.id, target.memberId, target.agent, entry.result.receivedAt],
              );
            }
            let pending = pendingChecks(runner.id, at);
            for (const target of due) {
              if (pending >= 4) return;
              const entry = last(target);
              if (
                entry &&
                (entry.inFlight ||
                  entry.issuedAt > at - SIGN_IN_INTERVAL_MS ||
                  (entry.result && entry.result.receivedAt > at - SIGN_IN_INTERVAL_MS))
              )
                continue;
              queueCheck(runner, target, at);
              pending += 1;
            }
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
    },
    /** Checks an agent right after its sign-in completes, unless a check is already in flight. */
    afterSignIn(runnerId: string, memberId: string, agent: Agent) {
      return immediate(db, () => {
        const at = now();
        const runner = getRunner(db, runnerId);
        if (
          !runner ||
          runner.status !== "active" ||
          !workspaceMember(db, runner.workspaceId, runner.ownerUserId)?.active ||
          history(runnerId, at)({ memberId, agent })?.inFlight ||
          pendingChecks(runnerId, at) >= 4
        )
          return false;
        queueCheck(runner, { memberId, agent }, at);
        return true;
      });
    },
    /** Sign-in status per agent, for the principal's own account on member-account runners. */
    agents(principal: WorkspacePrincipal, runnerId: string): AgentSignIn[] {
      const { runner } = visible(principal, runnerId);
      const at = now();
      const last = history(runnerId, at);
      const member = memberAccounts(runnerId);
      return runnerAgents.map((agent) => {
        const entry = last(member ? { memberId: principal.userId, agent } : { agent });
        const checkedAt = entry?.result?.receivedAt ?? null;
        if (entry?.inFlight) return { agent, status: "checking", checkedAt };
        if (entry?.result && !entry.result.authenticated)
          return { agent, status: "signed_out", checkedAt };
        const limit = member
          ? db
              .query<{ resetsAt: number }, [string, string, string, number]>(
                "SELECT cooldown_until AS resetsAt FROM runner_member_account WHERE runner_id=? AND user_id=? AND agent=? AND cooldown_until>?",
              )
              .get(runnerId, principal.userId, agent, at)
          : db
              .query<{ resetsAt: number }, [string, string, number]>(
                "SELECT COALESCE(resets_at,cooldown_until) AS resetsAt FROM runner_agent_policy WHERE runner_id=? AND agent=? AND quota_state='exhausted' AND cooldown_until>?",
              )
              .get(runner.id, agent, at);
        const usage = runnerAgentUsage(db, runnerId, member ? principal.userId : undefined, agent);
        const limits = usage ? { limits: usage.limits, limitsAt: usage.observedAt } : {};
        if (limit)
          return { agent, status: "usage_limit", checkedAt, resetsAt: limit.resetsAt, ...limits };
        if (entry?.result) return { agent, status: "signed_in", checkedAt, ...limits };
        return { agent, status: "unknown", checkedAt };
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
        authorizeRunnerAccount(db, assigned);
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
        if (assigned.type === "login_check" && assigned.memberId && result.login)
          db.run(
            "UPDATE runner_member_account SET connected=?,updated_at=? WHERE runner_id=? AND user_id=? AND agent=?",
            [result.login.authenticated ? 1 : 0, at, runnerId, assigned.memberId, assigned.agent],
          );
        if (result.agentLimits)
          recordRunnerAgentUsage(db, {
            runnerId,
            memberId: assigned.memberId,
            agent: assigned.type === "login_check" ? assigned.agent : assigned.profile.agent,
            limits: result.agentLimits,
            observedAt: at,
          });
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
      authorizeRunnerAccount(db, command(commandId, runnerId));
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
        return json(
          api.submit(
            runnerId,
            RunnerHealthResultSchema.parse(await body(request, RUNNER_RESULT_BODY_LIMIT)),
          ),
        );
      } catch {
        return json({ error: "Runner health result was rejected." }, 403);
      }
    },
  };
  return api;
}

async function body(request: Request, limit = 131_072) {
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
      if (bytes > limit) throw new Error("Runner health payload exceeds limit");
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
