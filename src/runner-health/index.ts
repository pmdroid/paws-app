import {
  workspaceMemberUsable,
  auditWorkspaceAccessSteps,
  commandAccountSteps,
  emitJobReady,
  getRunnerSteps,
  HEALTH_COMMAND_KINDS,
  healthCheckHistorySteps,
  healthCommandEnvelopeSteps,
  healthResultJsonSteps,
  insertHealthResultSteps,
  LOGIN_CHECK_KINDS,
  pendingHealthChecksSteps,
  recordAccountObservationSteps,
  recordRunnerAgentUsageSteps,
  runnerAgentCheckStatesSteps,
  runnerAgentPolicyRowSteps,
  runnerAgentUsageSteps,
  runnerLaneHelperWaitingSteps,
  runnerLastSeenSteps,
  seenMemberRunnersSteps,
  setLegacyAgentQuotaSteps,
  setLegacyAgentReadySteps,
  sqliteDb,
  touchRunnerSeenSteps,
  wakeRunnerSlotWaitsSteps,
  workspaceMemberSteps,
  type Q,
  type RunnerAgentLimit,
  type Steps,
} from "../db";
import { isWorkspaceAdmin } from "../workspace";
import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { WorkspacePrincipal } from "../workspace";
import type { RunnerWork } from "../runner-work";
import {
  RunnerCommandSchema,
  RUNNER_RESULT_BODY_LIMIT,
  RunnerHealthResultSchema,
  RunnerProfileSchema,
  runnerAccountEchoed,
  type RunnerHealthResult,
} from "../runner-protocol";

const requestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("probe"), profile: RunnerProfileSchema }),
  z.strictObject({
    type: z.literal("login_check"),
    agent: z.enum(["claude", "codex", "grok", "opencode"]),
  }),
]);
type HealthRequest = z.infer<typeof requestSchema>;
type Agent = "claude" | "codex" | "grok" | "opencode";
export type AgentSignIn = {
  agent: Agent;
  status: "signed_in" | "signed_out" | "checking" | "usage_limit" | "extra_usage" | "unknown";
  checkedAt: number | null;
  extraUsage?: true;
  resetsAt?: number | null;
  limits?: RunnerAgentLimit[];
  limitsAt?: number;
};
type History = {
  inFlight: boolean;
  issuedAt: number;
  result: { authenticated: boolean; receivedAt: number } | null;
};
const SIGN_IN_INTERVAL_MS = 5 * 60_000;
const PASSED_CHECK_INTERVAL_MS = 30 * 60_000;
const RECENT_USE_MS = 24 * 60 * 60_000;
const RECENTLY_SEEN_MS = 60_000;
const runnerAgents = ["claude", "codex", "grok", "opencode"] as const;

/**
 * Whether a background check of this agent is due. An agent nothing has answered for yet gets
 * one, because a check is what finds out whether it is signed in. After that only an agent
 * signed in here or used here recently is checked: every 30 minutes while it passes, else every 5.
 */
function checkDue(
  entry: History | undefined,
  state: { authExpired: number; lastUsedAt: number } | undefined,
  at: number,
) {
  if (entry?.inFlight || (entry && entry.issuedAt > at - SIGN_IN_INTERVAL_MS)) return false;
  if (!entry?.result) return true;
  const signedIn = entry.result.authenticated && state?.authExpired !== 1;
  if (!signedIn && (state?.lastUsedAt ?? 0) <= at - RECENT_USE_MS) return false;
  return entry.result.receivedAt < at - (signedIn ? PASSED_CHECK_INTERVAL_MS : SIGN_IN_INTERVAL_MS);
}

export function createRunnerHealth(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
}) {
  const { db, work } = options;
  const store = sqliteDb(db);
  const now = options.now ?? Date.now;
  function* visibleSteps(q: Q, principal: WorkspacePrincipal, runnerId: string) {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    const runner = yield* getRunnerSteps(q, runnerId);
    if (!workspaceMemberUsable(member) || runner?.workspaceId !== principal.workspaceId)
      throw new Error("Runner access denied");
    return { member, runner };
  }
  /** The runner, while it is not revoked and its owner may still use the workspace. */
  function* identitySteps(q: Q, runnerId: string) {
    const runner = yield* getRunnerSteps(q, runnerId);
    if (
      !runner ||
      runner.status === "revoked" ||
      !workspaceMemberUsable(yield* workspaceMemberSteps(q, runner.workspaceId, runner.ownerUserId))
    )
      throw new Error("Runner identity is unavailable");
    return runner;
  }
  function* commandSteps(q: Q, commandId: string, runnerId: string) {
    const envelopeJson = yield* healthCommandEnvelopeSteps(q, commandId, runnerId);
    if (envelopeJson === null) throw new Error("Runner health command is unavailable");
    const envelope = JSON.parse(envelopeJson) as { payload: string };
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
  /** Latest sign-in checks per agent. Bounded so old command rows are not rescanned. */
  function* historySteps(
    q: Q,
    runnerId: string,
    at: number,
  ): Steps<(agent: Agent) => History | undefined> {
    const latest = new Map<string, History>();
    const rows = yield* healthCheckHistorySteps(q, runnerId, LOGIN_CHECK_KINDS, 256);
    for (const row of rows) {
      const envelope = JSON.parse(row.envelope) as { payload: string };
      const value = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as {
        id: string;
        type: string;
        runnerId: string;
        agent: Agent;
        issuedAt: number;
      };
      if (value.type !== "login_check" || value.id !== row.id || value.runnerId !== runnerId)
        continue;
      const entry = latest.get(value.agent) ?? {
        inFlight: false,
        issuedAt: value.issuedAt,
        result: null,
      };
      latest.set(value.agent, entry);
      if (row.resultJson === null) {
        if (row.expiresAt > at) entry.inFlight = true;
      } else if (!entry.result) {
        const login = RunnerHealthResultSchema.parse(JSON.parse(row.resultJson)).login;
        if (login)
          entry.result = { authenticated: login.authenticated, receivedAt: row.receivedAt! };
      }
    }
    return (agent: Agent) => latest.get(agent);
  }
  function queueCheck(runner: { id: string; workspaceId: string }, agent: Agent, at: number) {
    work.enqueue({
      id: randomUUID(),
      type: "login_check",
      runnerId: runner.id,
      workspaceId: runner.workspaceId,
      agent,
      issuedAt: at,
      expiresAt: at + 120_000,
    });
  }
  const api = {
    async request(principal: WorkspacePrincipal, runnerId: string, input: HealthRequest) {
      const parsed = requestSchema.parse(input);
      return store.transaction(function* (q) {
        const at = now();
        const { member, runner } = yield* visibleSteps(q, principal, runnerId);
        if (!isWorkspaceAdmin(member.role))
          throw new Error("Workspace administrator access is required");
        if ((yield* pendingHealthChecksSteps(q, runnerId, at)) >= 4)
          throw new Error("Runner health checks are already pending");
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
        yield* auditWorkspaceAccessSteps(q, {
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
     * Queues a login_check per agent that is due on active, recently seen runners. Queues nothing
     * on a runner while a helper waits for its lane. Never queues probe: it runs a model turn.
     */
    async refresh() {
      const at = now();
      const runners = await store.run((q) => seenMemberRunnersSteps(q, at - RECENTLY_SEEN_MS));
      const errors: unknown[] = [];
      for (const runner of runners) {
        try {
          await store.transaction(function* (q) {
            if (yield* runnerLaneHelperWaitingSteps(q, runner.id, at)) return;
            const last = yield* historySteps(q, runner.id, at);
            const states = new Map(
              (yield* runnerAgentCheckStatesSteps(q, runner.id)).map((state) => [
                state.agent,
                state,
              ]),
            );
            let pending = yield* pendingHealthChecksSteps(q, runner.id, at);
            for (const agent of runnerAgents) {
              if (!work.supportsAgent(runner.id, agent)) continue;
              if (pending >= 4) return;
              if (!checkDue(last(agent), states.get(agent), at)) continue;
              queueCheck(runner, agent, at);
              pending += 1;
            }
          });
        } catch (error) {
          journalCaught(error, "runner-health.refresh.immediate", null);
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
    },
    /** Checks an agent right after its sign-in completes, unless a check is already in flight. */
    afterSignIn(runnerId: string, agent: Agent) {
      return store.transaction(function* (q) {
        const at = now();
        const runner = yield* getRunnerSteps(q, runnerId);
        if (
          !runner ||
          !work.supportsAgent(runnerId, agent) ||
          runner.status !== "active" ||
          !workspaceMemberUsable(
            yield* workspaceMemberSteps(q, runner.workspaceId, runner.ownerUserId),
          ) ||
          (yield* historySteps(q, runnerId, at))(agent)?.inFlight ||
          (yield* pendingHealthChecksSteps(q, runnerId, at)) >= 4
        )
          return false;
        queueCheck(runner, agent, at);
        return true;
      });
    },
    agents(principal: WorkspacePrincipal, runnerId: string): Promise<AgentSignIn[]> {
      return store.run(function* (q) {
        const { runner } = yield* visibleSteps(q, principal, runnerId);
        const at = now();
        const last = yield* historySteps(q, runnerId, at);
        const signIns: AgentSignIn[] = [];
        for (const agent of runnerAgents) {
          const entry = last(agent);
          const checkedAt = entry?.result?.receivedAt ?? null;
          const policy = yield* runnerAgentPolicyRowSteps(q, runner.id, agent);
          const extraUsage = policy?.extraUsage === 1;
          const extra = extraUsage ? { extraUsage: true as const } : {};
          if (entry?.inFlight) {
            signIns.push({ agent, status: "checking", checkedAt, ...extra });
            continue;
          }
          if (entry?.result && !entry.result.authenticated) {
            signIns.push({ agent, status: "signed_out", checkedAt, ...extra });
            continue;
          }
          const usage = yield* runnerAgentUsageSteps(q, runnerId, agent);
          const limits = usage ? { limits: usage.limits, limitsAt: usage.observedAt } : {};
          if (policy?.quotaState === "exhausted" && policy.cooldownUntil > at)
            signIns.push({
              agent,
              status: "usage_limit",
              checkedAt,
              ...extra,
              resetsAt: policy.resetsAt ?? policy.cooldownUntil,
              ...limits,
            });
          else if (policy?.quotaState === "spent_extra" && extraUsage)
            signIns.push({
              agent,
              status: "extra_usage",
              checkedAt,
              ...extra,
              resetsAt: policy.resetsAt,
              ...limits,
            });
          else if (entry?.result)
            signIns.push({ agent, status: "signed_in", checkedAt, ...extra, ...limits });
          else signIns.push({ agent, status: "unknown", checkedAt, ...extra });
        }
        return signIns;
      });
    },
    async submit(runnerId: string, input: RunnerHealthResult) {
      const result = RunnerHealthResultSchema.parse(input);
      let woke = false;
      const submitted = await store.transaction(function* (q) {
        const runner = yield* identitySteps(q, runnerId);
        const assigned = yield* commandSteps(q, result.commandId, runnerId);
        const at = now();
        if (
          assigned.workspaceId !== runner.workspaceId ||
          assigned.issuedAt > at ||
          assigned.expiresAt <= at
        )
          throw new Error("Runner health command has expired");
        if (
          !runnerAccountEchoed(assigned, result) ||
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
        const previous = yield* healthResultJsonSteps(q, result.commandId);
        if (previous !== null) {
          if (previous !== value) throw new Error("Runner health result changed");
          return { duplicate: true };
        }
        yield* insertHealthResultSteps(q, result.commandId, runnerId, value, at);
        const legacy = !assigned.account;
        const owner =
          assigned.type === "login_check" ? yield* commandAccountSteps(q, assigned.id) : null;
        function* observe(
          state: "ok" | "auth_required" | "exhausted" | "low",
          kind: "auth" | "quota",
          resetsAt: number | null = null,
        ) {
          if (!owner) return true;
          const base = {
            bindingId: owner.bindingId,
            source: "login_check" as const,
            sourceId: assigned.id,
            observedAt: assigned.issuedAt,
            now: at,
          };
          const observation =
            state === "ok"
              ? { ...base, state, clears: [kind] }
              : state === "exhausted"
                ? { ...base, state, resetsAt }
                : { ...base, state };
          const outcome = (yield* q.transaction((tx) =>
            recordAccountObservationSteps(tx, observation),
          ))[kind];
          return outcome === "applied";
        }
        if (
          assigned.type === "login_check" &&
          result.login &&
          (yield* observe(result.login.authenticated ? "ok" : "auth_required", "auth")) &&
          legacy
        ) {
          yield* setLegacyAgentReadySteps(q, runnerId, assigned.agent, result.login.authenticated);
          if (result.login.authenticated) woke = yield* wakeRunnerSlotWaitsSteps(q, runnerId, at);
        }
        if (legacy && result.agentLimits)
          yield* recordRunnerAgentUsageSteps(q, {
            runnerId,
            agent: assigned.type === "login_check" ? assigned.agent : assigned.profile.agent,
            limits: result.agentLimits,
            observedAt: at,
          });
        if (assigned.type === "login_check" && result.login?.authenticated && result.agentLimits) {
          const extraUsage =
            (yield* runnerAgentPolicyRowSteps(q, runnerId, assigned.agent))?.extraUsage === 1;
          const spent = result.agentLimits.filter((limit) => limit.usedPercent >= 100);
          const until = spent.length
            ? Math.max(...spent.map((limit) => limit.resetsAt ?? at + 15 * 60_000))
            : null;
          const resetsAt = spent.every((limit) => limit.resetsAt !== null) ? until : null;
          const low = result.agentLimits.some((limit) => limit.usedPercent >= 80);
          const cools = spent.length > 0 && !extraUsage;
          if (
            (yield* observe(cools ? "exhausted" : low ? "low" : "ok", "quota", resetsAt)) &&
            legacy
          )
            yield* setLegacyAgentQuotaSteps(q, runnerId, assigned.agent, {
              state: cools ? "exhausted" : spent.length ? "spent_extra" : "ok",
              resetsAt: until,
              cooldownUntil: cools ? until! : 0,
            });
        }
        yield* touchRunnerSeenSteps(q, runnerId, at);
        return { duplicate: false };
      });
      if (woke) emitJobReady(store);
      return submitted;
    },
    async read(runnerId: string, commandId: string) {
      const resultJson = await store.run(function* (q) {
        yield* identitySteps(q, runnerId);
        if ((yield* commandSteps(q, commandId, runnerId)).expiresAt <= now())
          throw new Error("Runner health command has expired");
        return yield* healthResultJsonSteps(q, commandId, runnerId);
      });
      return resultJson ? RunnerHealthResultSchema.parse(JSON.parse(resultJson)) : null;
    },
    async list(principal: WorkspacePrincipal, runnerId: string) {
      return store.run(function* (q) {
        yield* visibleSteps(q, principal, runnerId);
        const checks = [];
        for (const row of yield* healthCheckHistorySteps(q, runnerId, HEALTH_COMMAND_KINDS, 12))
          checks.push({
            command: yield* commandSteps(q, row.id, runnerId),
            expiresAt: row.expiresAt,
            receivedAt: row.receivedAt,
            result: row.resultJson
              ? RunnerHealthResultSchema.parse(JSON.parse(row.resultJson))
              : null,
          });
        const lastSeenAt = yield* runnerLastSeenSteps(q, runnerId);
        return { lastSeenAt, checks };
      });
    },
    async browser(request: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const match = /^\/api\/runners\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/health$/.exec(
        new URL(request.url).pathname,
      );
      if (!match) return null;
      try {
        if (request.method === "GET") return json(await api.list(principal, match[1]!));
        if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        return json(
          await api.request(principal, match[1]!, requestSchema.parse(await body(request))),
        );
      } catch (caughtError1) {
        journalCaught(caughtError1, "runner-health.browser.json", null);
        return json({ error: "Runner health request is unavailable." }, 403);
      }
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      if (new URL(request.url).pathname !== "/v1/health") return null;
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      try {
        return json(
          await api.submit(
            runnerId,
            RunnerHealthResultSchema.parse(await body(request, RUNNER_RESULT_BODY_LIMIT)),
          ),
        );
      } catch (caughtError2) {
        journalCaught(caughtError2, "runner-health.fetch.json", null);
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
  const cancel = () =>
    void reader.cancel().catch((caughtError3) => {
      journalCaught(caughtError3, "runner-health.body.cancel", null);
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
      if (bytes > limit) throw new Error("Runner health payload exceeds limit");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch((caughtError4) => {
      journalCaught(caughtError4, "runner-health.body.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export type RunnerHealth = ReturnType<typeof createRunnerHealth>;
