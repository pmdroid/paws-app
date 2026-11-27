import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { RepositoryBinding } from "../core";
import {
  enqueueJob,
  insertRunnerExecutionUsageSteps,
  listRunnersSteps,
  runnerHelperAvailabilitySteps,
  runnerHostVersionSteps,
  runnerStandingSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { memberRepositoriesSteps } from "../improvements";
import { journal, journalCaught } from "../journal";
import type { RunnerHelpers } from "../runner-helpers";
import {
  RUNNER_ONLINE_MS,
  resolveRunnerAccountSteps,
  type PlacementAccount,
  type RunnerPlacement,
} from "../runner-placement";
import {
  MINIMUM_RUNNER_VERSION,
  runnerReleaseAtLeast,
  type RunnerCodingAgent,
  type RunnerHelperResult,
} from "../runner-protocol";
import { json, localRequest, readJson, sameToken } from "../settings";
import { isWorkspaceAdmin } from "../workspace";
import { collectProbes, type CollectOptions, type CollectResult } from "./collect";
import { DEFAULT_OUT } from "./output";
import { DEFAULT_SINCE_DAYS } from "./sources";
import type { AgentTurn } from "./types";

export const PROBE_COLLECT_JOB = "probes.collect";

type Profile = { agent: RunnerCodingAgent; model: string | null };
type Placed = { runnerId: string; ownerUserId: string; account: PlacementAccount };

const StartSchema = z.strictObject({
  workspaceId: z.string().min(1),
  userId: z.string().min(1).nullable(),
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/),
});
type Start = z.infer<typeof StartSchema>;

type Located = Pick<CollectOptions, "github" | "networkGit"> & { repository: RepositoryBinding };

export function* probeCollectionAllowedSteps(
  q: Q,
  input: { workspaceId: string; userId: string; repository?: string },
): Steps<boolean> {
  const member = yield* workspaceMemberSteps(q, input.workspaceId, input.userId);
  if (!workspaceMemberUsable(member) || !isWorkspaceAdmin(member.role)) return false;
  const name = input.repository?.toLowerCase();
  if (name === undefined) return true;
  const repositories = yield* memberRepositoriesSteps(q, input.workspaceId, input.userId);
  return repositories.some((repository) => repository.toLowerCase() === name);
}

function* placeSteps(q: Q, input: Start, profile: Profile, at: number): Steps<Placed | string> {
  const runners = (yield* listRunnersSteps(q, input.workspaceId))
    .filter((runner) => runner.status === "active")
    .sort(
      (a, b) => Number(b.ownerUserId === input.userId) - Number(a.ownerUserId === input.userId),
    );
  let refused: string | null = null;
  for (const runner of runners) {
    const allowed = yield* probeCollectionAllowedSteps(q, {
      workspaceId: input.workspaceId,
      userId: runner.ownerUserId,
      repository: input.repository,
    });
    const seen = (yield* runnerStandingSteps(q, runner.id))?.lastSeenAt;
    const release = yield* runnerHostVersionSteps(q, runner.id);
    if (!allowed || !seen || seen <= at - RUNNER_ONLINE_MS) continue;
    const fit = yield* resolveRunnerAccountSteps(q, runner, input.workspaceId, {
      agent: profile.agent,
      model: profile.model,
      purpose: "helper",
      role: "implementer",
      at,
    });
    if (!runnerReleaseAtLeast(release, MINIMUM_RUNNER_VERSION))
      refused ??= `${runner.name} needs runner ${MINIMUM_RUNNER_VERSION.join(".")} or later`;
    else if ("reason" in fit) refused ??= `No signed-in ${profile.agent} account on ${runner.name}`;
    else if ((yield* runnerHelperAvailabilitySteps(q, runner.id, at, true)).available)
      return { runnerId: runner.id, ownerUserId: runner.ownerUserId, account: fit.account };
    else refused ??= `${runner.name} is busy with another helper turn`;
  }
  return refused ?? `No online runner of a workspace admin can read ${input.repository}`;
}

export function createProbeCollection(options: {
  store: Db;
  pawsRoot: string;
  helpers: () => Promise<RunnerHelpers | null | undefined>;
  placement: Pick<RunnerPlacement, "finishedSteps">;
  profile: () => Profile;
  locate: (repository: string) => Located | null;
  now?: () => number;
  pollIntervalMs?: number;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const poll = options.pollIntervalMs ?? 1_000;
  const place = (input: Start, profile: Profile) =>
    store.run((q) => placeSteps(q, input, profile, now()));

  function runnerTurn(
    helpers: RunnerHelpers,
    placed: Placed,
    profile: Profile,
    repository: string,
  ): AgentTurn {
    return async (turn) => {
      const command = await store.transaction(function* (q) {
        const { command: dispatched } = yield* helpers.dispatchSteps(q, {
          runnerId: placed.runnerId,
          sessionId: `probes-${Bun.randomUUIDv7()}`,
          purpose: turn.probe ? "probe_write" : "probe_distill",
          profile,
          prompt: turn.prompt,
          account: { accountId: placed.account.accountId, bindingId: placed.account.bindingId },
          ...(turn.probe ? { probe: { repository, path: turn.probe } } : {}),
        });
        yield* insertRunnerExecutionUsageSteps(q, {
          commandId: dispatched.id,
          runnerId: dispatched.runnerId,
          ownerUserId: placed.ownerUserId,
          itemId: null,
          runId: null,
          agent: profile.agent,
          model: profile.model,
          role: "implementer",
          purpose: "helper",
          startedAt: now(),
          placementReason: null,
        });
        return dispatched;
      });
      let outcome: RunnerHelperResult | "timeout" = "timeout";
      try {
        while (now() < command.expiresAt) {
          turn.signal?.throwIfAborted();
          const result = await helpers.result(command.id);
          if (result) {
            outcome = result;
            break;
          }
          await delay(poll, undefined, turn.signal ? { signal: turn.signal } : {});
        }
      } finally {
        const finished = outcome;
        await store
          .transaction((q) =>
            options.placement.finishedSteps(q, {
              commandId: command.id,
              runnerId: command.runnerId,
              profile,
              ...(finished === "timeout" ? { failure: finished } : { result: finished }),
              finishedAt: now(),
            }),
          )
          .catch((error: unknown) => journalCaught(error, "probe-collector.settle", null));
        await helpers
          .finish(command.id)
          .catch((error: unknown) => journalCaught(error, "probe-collector.finish", null));
      }
      if (outcome === "timeout") throw new Error("The probe helper turn ran out of time.");
      const probe = outcome.probe && outcome.probe.path === turn.probe ? outcome.probe : null;
      if (probe) {
        const path = join(turn.worktreePath, probe.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(probe.content, "base64"));
      }
      const text = probe ? `\`\`\`json\n${JSON.stringify(probe.entry)}\n\`\`\`` : outcome.text;
      await turn.onEvent?.({
        type: "session_update",
        sessionId: command.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      return {
        role: turn.role,
        stopReason: outcome.stopReason,
        timedOut: outcome.timedOut,
        cancelled: outcome.cancelled,
        authRequired: outcome.authRequired,
        agentExited: outcome.agentExited,
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      };
    };
  }

  return {
    async start(input: unknown): Promise<{ status: number; body: unknown }> {
      const parsed = StartSchema.safeParse(input);
      if (!parsed.success)
        return { status: 400, body: { error: "Name a repository as owner/repo." } };
      const placed = await place(parsed.data, options.profile());
      if (typeof placed === "string") return { status: 409, body: { error: placed } };
      const jobId = await enqueueJob(store, {
        queue: PROBE_COLLECT_JOB,
        payload: parsed.data,
        maxAttempts: 1,
      });
      return { status: 202, body: { jobId } };
    },
    async run(payload: unknown, signal: AbortSignal): Promise<CollectResult> {
      const input = StartSchema.parse(payload);
      const profile = options.profile();
      const placed = await place(input, profile);
      if (typeof placed === "string") throw new Error(placed);
      const helpers = await options.helpers();
      if (!helpers) throw new Error("Paws has no runner connection.");
      const located = options.locate(input.repository);
      if (!located) throw new Error(`No GitHub App installation covers ${input.repository}.`);
      const { owner, repo } = located.repository;
      const out = join(options.pawsRoot, "probes", owner, repo, DEFAULT_OUT);
      await mkdir(dirname(out), { recursive: true });
      return collectProbes({
        ...located,
        pawsRoot: options.pawsRoot,
        since: new Date(now() - DEFAULT_SINCE_DAYS * 86_400_000),
        dryRun: false,
        out,
        turn: runnerTurn(helpers, placed, profile, input.repository),
        findings: async () => [],
        keep: async (candidates) => candidates.map((candidate) => candidate.id),
        print: (text) => journal(`probes ${input.repository}: ${text}`),
        signal,
      });
    },
  };
}

export type ProbeCollection = ReturnType<typeof createProbeCollection>;

export async function handleProbeCollectionRequest(
  request: Request,
  options: {
    collection: Pick<ProbeCollection, "start">;
    csrfToken: string;
    workspaceId: string;
    role?: string;
    userId?: string;
    trustedOrigin?: string;
  },
): Promise<Response> {
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Probe collection is only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can collect probes." }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  const repository = (body as { repository?: unknown } | null)?.repository;
  const reply = await options.collection.start({
    workspaceId: options.workspaceId,
    userId: options.userId ?? null,
    repository,
  });
  return json(reply.body, reply.status);
}
