import { createHash } from "node:crypto";
import { z } from "zod";
import { journalCaught } from "../journal";
import {
  workspaceMemberUsable,
  accountSlotsInUseSteps,
  acknowledgeRetroDispatchSteps,
  admitAgentAccountsSteps,
  AgentAccountError,
  agentAccountConcurrencySteps,
  closeRetroSteps,
  deliverableRetroDispatchesSteps,
  failRetroAttemptSteps,
  getRetroDispatchSteps,
  getRetroSteps,
  latestRetroDispatchSteps,
  retroGenerationSteps,
  listRetroAttemptsSteps,
  listWorkspaceMembersSteps,
  liveAccountBindingSteps,
  markRetroDispatchFetchedSteps,
  newRetroCommandId,
  openRetroDispatchSteps,
  pinnedSlotsReservedSteps,
  readRetroArtifactSteps,
  recordCommandAccountSteps,
  recordRetroDispatchSteps,
  recordRetroDispatchResultSteps,
  recordRetroGenerationSteps,
  releaseRetroDispatchSteps,
  requestRetroDispatchCancelSteps,
  resignRetroDispatchSteps,
  RETRO_WAIT_DIAGNOSTICS,
  retroArtifactSteps,
  retroDispatchesNotStartedSteps,
  runnerHasCapacitySteps,
  runnerOccupancySteps,
  runnerSlotsHeldBetweenCommandsSteps,
  settleRetroDispatchSteps,
  startRetroAttemptSteps,
  workspaceMemberSteps,
  previousRetroResultDispatchSteps,
  retroDispatchReleaseReasonSteps,
  retrosToAdvanceSteps,
  runnerHostVersionSteps,
  runnerIdentitySteps,
  type Db,
  type Q,
  type RunnerIdentity,
  type Retro,
  type RetroDispatch,
  type RetroGenerationDiagnostic,
  type Steps,
} from "../db";
import {
  BINDING_REASON_TEXT,
  bindingReadinessSteps,
  eligibleRunnersSteps,
  type BindingUnavailableReason,
  type EligibleRunner,
} from "../runner-placement";
import {
  acceptRetroResult,
  authorizeRetroInput,
  RUNNER_RESULT_BODY_LIMIT,
  RUNNER_RETRO_CAPABILITY,
  RUNNER_RETRO_LIMITS,
  RunnerRetroCommandSchema,
  runnerAcceptsRetro,
  runnerRetroInputGrant,
  type RunnerCodingAgent,
  type RunnerRetroCommand,
  type RunnerRetroResult,
  type SignedRunnerCommand,
} from "../runner-protocol";
import { runnerRequestUnavailable } from "../runner-work";
import { isWorkspaceAdmin } from "../workspace";
import { freezeRenderedRetroPrompt, retroRepairPrompt } from "./prompt";
import {
  RETRO_RESULT_LIMITS,
  retroNeedsGeneration,
  retroOutputLimits,
  retroRepairProblems,
  settleRetroAttempt,
  settleRetroAttemptSteps,
} from "./result";
import { retroAttemptLimits, type RetroAgentProfile } from "./settings";
import type { RetroDigest } from "./digest";

export const RETRO_DISPATCH_JOB = "retro.dispatch";

export const RETRO_DISPATCH_TIMING = {
  commandTtlMs: 300_000,
  resignBeforeMs: 30_000,
  outcomeGraceMs: 300_000,
  notStartedGraceMs: 60_000,
  retryBaseMs: 60_000,
  retryCapMs: 1_800_000,
  tickMs: 15_000,
} as const;

export const RETRO_GENERATION_STATES = [
  "queued",
  "waiting_for_runner",
  "generating",
  "ready",
  "failed",
] as const;
export type RetroGenerationState = (typeof RETRO_GENERATION_STATES)[number];

export type RetroGenerationView = {
  retroId: string;
  state: RetroGenerationState;
  diagnostic: RetroGenerationDiagnostic | null;
  detail: string | null;
  since: number | null;
  until: number | null;
  attempt: number;
  attemptsUsed: number;
  maxAttempts: number;
  retry: { at: number } | null;
  runnerId: string | null;
  commandId: string | null;
  waitMs: number;
  activeMs: number;
  digestSha256: string | null;
  error: string | null;
};

export type RetroCommandSigner = (command: RunnerRetroCommand) => SignedRunnerCommand;

class RetroFencedError extends Error {}

const LOCAL_OWNER = "retro-dispatch:local";
const owner = (commandId: string) => `retro-dispatch:${commandId}`;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const MAX_OUTPUT_CHARS = Math.min(RUNNER_RETRO_LIMITS.outputChars, RETRO_RESULT_LIMITS.outputChars);

const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const exactBytes = (bytes: number) => `${bytes.toLocaleString("en-US")} bytes`;

function oversizedInput(kind: "digest" | "prompt", sizeBytes: number, limitBytes: number) {
  if (sizeBytes <= limitBytes) return null;
  return `The frozen ${kind} is ${mebibytes(sizeBytes)} (${exactBytes(sizeBytes)}); runners accept at most ${mebibytes(limitBytes)} (${exactBytes(limitBytes)}).`;
}

export function retroRetryDelayMs(attemptsUsed: number): number {
  const exponent = Math.max(0, attemptsUsed - 1);
  return Math.min(
    RETRO_DISPATCH_TIMING.retryCapMs,
    RETRO_DISPATCH_TIMING.retryBaseMs * 2 ** Math.min(exponent, 16),
  );
}

function* budgetSteps(q: Q, retro: Retro) {
  const notStarted = yield* retroDispatchesNotStartedSteps(q, retro.id);
  const { maxAttempts, activeExecutionMs } = retroAttemptLimits(retro.executionLimits);
  return { notStarted, maxAttempts, activeExecutionMs, used: retro.attempt - notStarted };
}

function* retryAtSteps(q: Q, retro: Retro) {
  if (retro.state !== "failed") return null;
  const { used, maxAttempts } = yield* budgetSteps(q, retro);
  if (used >= maxAttempts) return null;
  if ((yield* openRetroDispatchSteps(q, retro.id)) !== null) return null;
  const last = (yield* listRetroAttemptsSteps(q, retro.id)).at(-1);
  const notStarted =
    (yield* retroDispatchReleaseReasonSteps(q, retro.id, retro.attempt)) === "not_started";
  const finished = last?.finishedAt ?? retro.updatedAt;
  return (
    finished +
    retroRetryDelayMs(notStarted ? yield* retroDispatchesNotStartedSteps(q, retro.id) : used)
  );
}

export function* retroGenerationViewSteps(
  q: Q,
  retroId: string,
): Steps<RetroGenerationView | null> {
  const retro = yield* getRetroSteps(q, retroId);
  if (retro === null) return null;
  const row = yield* retroGenerationSteps(q, retroId);
  const { used, maxAttempts } = yield* budgetSteps(q, retro);
  const dispatch =
    (yield* openRetroDispatchSteps(q, retroId)) ?? (yield* latestRetroDispatchSteps(q, retroId));
  const latest = dispatch === null ? null : yield* getRetroDispatchSteps(q, dispatch.commandId);
  const waiting = row !== null && RETRO_WAIT_DIAGNOSTICS.includes(row.diagnostic);
  const state: RetroGenerationState = (() => {
    switch (retro.state) {
      case "published":
        return "ready";
      case "generating":
        return "generating";
      case "failed":
      case "abandoned":
      case "coverage_failed":
        return "failed";
      default:
        return waiting ? "waiting_for_runner" : "queued";
    }
  })();
  const at = yield* retryAtSteps(q, retro);
  return {
    retroId,
    state,
    diagnostic: row?.diagnostic ?? null,
    detail: row?.detail ?? null,
    since: row?.since ?? null,
    until: row?.until ?? null,
    attempt: retro.attempt,
    attemptsUsed: used,
    maxAttempts,
    retry: at === null ? null : { at },
    runnerId: latest?.runnerId ?? null,
    commandId: latest?.commandId ?? null,
    waitMs: row?.waitMs ?? 0,
    activeMs: row?.activeMs ?? 0,
    digestSha256: retro.digestSha256,
    error: retro.error,
  };
}

type Candidate = EligibleRunner & { occupied: number; capacity: number; free: boolean };

function* runnerHasWorkspaceAuthoritySteps(q: Q, identity: RunnerIdentity) {
  const member = yield* workspaceMemberSteps(q, identity.workspaceId, identity.ownerId);
  return workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
}

export async function retroRunnerCandidates(
  store: Db,
  input: { workspaceId: string; agent: string; now: number },
): Promise<{ candidates: Candidate[]; incompatible: number }> {
  const admins = (await store.run((q) => listWorkspaceMembersSteps(q, input.workspaceId))).filter(
    (member) => workspaceMemberUsable(member) && isWorkspaceAdmin(member.role),
  );
  const seen = new Set<string>();
  let incompatible = 0;
  const candidates: Candidate[] = [];
  for (const admin of admins) {
    const runners = await store.run((q) =>
      eligibleRunnersSteps(q, {
        workspaceId: input.workspaceId,
        teamId: "",
        ownerUserId: admin.id,
        leadUserIds: [],
        agent: input.agent,
        purpose: "work",
        now: input.now,
      }),
    );
    for (const runner of runners) {
      if (!runner.eligible || runner.ownerId !== admin.id || seen.has(runner.id)) continue;
      seen.add(runner.id);
      const version = await store.run((q) => runnerHostVersionSteps(q, runner.id));
      if (!runnerAcceptsRetro(version)) {
        incompatible += 1;
        continue;
      }
      const held =
        (await store.run((q) => runnerSlotsHeldBetweenCommandsSteps(q, runner.id, input.now))) +
        (await store.run((q) => pinnedSlotsReservedSteps(q, runner.id, "", input.now)));
      const { occupied, capacity } = await store.run((q) =>
        runnerOccupancySteps(q, runner.id, input.now),
      );
      candidates.push({
        ...runner,
        occupied: occupied + held,
        capacity,
        free: await store.run((q) => runnerHasCapacitySteps(q, runner.id, input.now, "", held)),
      });
    }
  }
  return { candidates, incompatible };
}

const HEALTH_HOLDS: ReadonlySet<BindingUnavailableReason> = new Set([
  "exhausted",
  "provider-restricted",
  "unsupported-model",
  "auth-required",
]);

type HealthHold = { reason: BindingUnavailableReason; until: number | null } | null;

function* accountHealthHoldSteps(
  q: Q,
  runnerId: string,
  accountId: string,
  model: string | null | undefined,
  now: number,
): Steps<HealthHold> {
  const binding = yield* liveAccountBindingSteps(q, runnerId, accountId);
  if (binding === null) return null;
  const readiness = yield* bindingReadinessSteps(q, { bindingId: binding.id, model, now });
  return !readiness.ready && HEALTH_HOLDS.has(readiness.reason)
    ? { reason: readiness.reason, until: readiness.until }
    : null;
}

function profileOf(retro: Retro): RetroAgentProfile {
  return retro.agentProfile as RetroAgentProfile;
}

async function readDigest(store: Db, root: string, retro: Retro): Promise<RetroDigest | null> {
  const stored = await store.run((q) => readRetroArtifactSteps(q, root, retro.id, "digest"));
  if (!stored.ok || stored.artifact.sha256 !== retro.digestSha256) return null;
  return JSON.parse(new TextDecoder().decode(stored.bytes)) as RetroDigest;
}

/**
 * The prompt an attempt runs: the frozen prompt, plus a repair block when the latest earlier
 * result failed validation with invalid_result. It derives from frozen inputs only, so every
 * read for the same attempt returns the same bytes.
 */
async function attemptPrompt(
  store: Db,
  retro: Retro,
  digest: RetroDigest,
  frozen: string,
  attempt: number,
): Promise<Uint8Array> {
  const previous = await store.run((q) => previousRetroResultDispatchSteps(q, retro.id, attempt));
  const result = previous === null ? null : (previous.result as RunnerRetroResult);
  const output = result?.outcome === "completed" ? (result.output ?? null) : null;
  const problems =
    output === null || retro.digestSha256 === null
      ? null
      : retroRepairProblems(output, {
          digest,
          digestSha256: retro.digestSha256,
          limits: retroOutputLimits(retro.outputLimits),
        });
  const text = problems === null ? frozen : retroRepairPrompt(frozen, problems, output!);
  return new TextEncoder().encode(text);
}

export function createRetroDispatcher(options: {
  store: Db;
  artifactRoot: string;
  sign: RetroCommandSigner;
  now?: () => number;
}) {
  const { store, artifactRoot: root } = options;
  const now = options.now ?? Date.now;

  function* noteSteps(
    q: Q,
    retroId: string,
    diagnostic: RetroGenerationDiagnostic,
    detail: string,
    extra: { until?: number | null; activeMs?: number } = {},
  ) {
    yield* recordRetroGenerationSteps(q, { retroId, diagnostic, detail, now: now(), ...extra });
  }

  async function note(
    retroId: string,
    diagnostic: RetroGenerationDiagnostic,
    detail: string,
    extra: { until?: number | null; activeMs?: number } = {},
  ) {
    await store.transaction((q) => noteSteps(q, retroId, diagnostic, detail, extra));
  }

  function* afterFailureSteps(q: Q, retroId: string) {
    const retro = yield* getRetroSteps(q, retroId);
    if (retro === null) return;
    if (retro.state !== "failed") {
      if (retro.state === "abandoned" || retro.state === "coverage_failed")
        yield* noteSteps(q, retroId, "failed", retro.error ?? "The retro was closed.");
      return;
    }
    const at = yield* retryAtSteps(q, retro);
    if (at === null)
      yield* noteSteps(q, retroId, "failed", retro.error ?? "The retro could not be generated.");
    else
      yield* noteSteps(q, retroId, "retry_backoff", retro.error ?? "The attempt failed.", {
        until: Math.max(at, now()),
      });
  }

  async function settle(released: RetroDispatch) {
    await store.transaction(function* (q) {
      const dispatch = yield* getRetroDispatchSteps(q, released.commandId);
      if (dispatch === null || dispatch.releasedAt === null || dispatch.settledAt !== null) return;
      yield* settleOnceSteps(q, dispatch);
    });
  }

  function* settleOnceSteps(q: Q, dispatch: RetroDispatch) {
    const at = now();
    const fail = (error: string) =>
      failRetroAttemptSteps(q, {
        retroId: dispatch.retroId,
        attempt: dispatch.attempt,
        owner: owner(dispatch.commandId),
        error: error.slice(0, 2000),
        now: at,
      });
    const result = dispatch.result as RunnerRetroResult | null;
    if (dispatch.releaseReason === "result" && result !== null) {
      const retro = yield* getRetroSteps(q, dispatch.retroId);
      if (retro?.state === "generating" && retro.attempt === dispatch.attempt)
        yield* recordRetroGenerationSteps(q, {
          retroId: dispatch.retroId,
          diagnostic: "active",
          detail: `The runner reported ${result.outcome}.`,
          now: at,
          activeMs: result.activeMs,
        });
      const identity = yield* runnerIdentitySteps(q, dispatch.runnerId);
      if (identity === null || !(yield* runnerHasWorkspaceAuthoritySteps(q, identity)))
        yield* fail("The runner's owner lost workspace authority before the result arrived.");
      else if (result.outcome === "completed") {
        const settled = yield* settleRetroAttemptSteps(q, root, {
          retroId: dispatch.retroId,
          attempt: dispatch.attempt,
          owner: owner(dispatch.commandId),
          output: result.output ?? null,
          now: at,
        });
        if (settled.ok)
          yield* noteSteps(q, dispatch.retroId, "ready", "The retro report is published.");
        else if (settled.reason === "coverage_gap")
          yield* closeRetroSteps(q, {
            retroId: dispatch.retroId,
            state: "coverage_failed",
            error: "The retro has a coverage gap and cannot be published.",
            now: at,
          });
        else if (settled.reason === "watermark_moved")
          yield* closeRetroSteps(q, {
            retroId: dispatch.retroId,
            state: "abandoned",
            error: "Another retro already published activity from this window.",
            now: at,
          });
        else if (settled.reason === "unknown_evidence" || settled.reason === "duplicate_item")
          yield* fail(`The result did not match its evidence: ${settled.reason}.`);
      } else {
        const message = result.errorMessage ?? `The retro turn ended with ${result.outcome}.`;
        yield* fail(`${result.outcome}: ${message}`);
      }
    } else if (dispatch.releaseReason === "not_started")
      yield* fail("The runner did not start the retro command.");
    else if (dispatch.releaseReason === "teardown")
      yield* fail("The runner ended the retro turn without a result.");
    yield* settleRetroDispatchSteps(q, dispatch.commandId, at);
    yield* afterFailureSteps(q, dispatch.retroId);
  }

  async function releaseNotStarted(commandId: string, at: number) {
    await store.run((q) =>
      releaseRetroDispatchSteps(q, { commandId, reason: "not_started", now: at }),
    );
    return settle((await store.run((q) => getRetroDispatchSteps(q, commandId)))!);
  }

  async function observe(dispatch: RetroDispatch) {
    const at = now();
    if (dispatch.releasedAt !== null) return settle(dispatch);
    const identity = await store.run((q) => runnerIdentitySteps(q, dispatch.runnerId));
    const fenced =
      identity === null ||
      identity.revokedAt !== null ||
      identity.status === "revoked" ||
      identity.fence !== dispatch.runnerFence;
    const authorized =
      !fenced && (await store.run((q) => runnerHasWorkspaceAuthoritySteps(q, identity)));
    if (!authorized && dispatch.fetchedAt === null && dispatch.acknowledgedAt === null)
      return releaseNotStarted(dispatch.commandId, at);
    if (fenced || identity === null)
      return note(
        dispatch.retroId,
        "unknown_outcome",
        "The runner lost its identity after receiving the command. Its slot and attempt stay fenced until it reports a result or confirms teardown.",
      );
    const command = dispatch.command as RunnerRetroCommand;
    if (dispatch.acknowledgedAt === null) {
      const seenAfterExpiry =
        (identity.lastSeenAt ?? 0) > dispatch.expiresAt + RETRO_DISPATCH_TIMING.notStartedGraceMs;
      if (dispatch.cancelRequestedAt !== null && dispatch.fetchedAt === null)
        return releaseNotStarted(dispatch.commandId, at);
      if (dispatch.fetchedAt === null && dispatch.expiresAt <= at)
        return releaseNotStarted(dispatch.commandId, at);
      if (dispatch.fetchedAt !== null && dispatch.expiresAt <= at && seenAfterExpiry)
        return releaseNotStarted(dispatch.commandId, at);
      await note(
        dispatch.retroId,
        "dispatched",
        dispatch.fetchedAt === null
          ? "Sent to a paired runner. Waiting for it to fetch the command."
          : "The runner fetched the command. Waiting for it to start.",
      );
      return;
    }
    const deadline =
      dispatch.acknowledgedAt +
      command.executionLimit.activeMinutes * 60_000 +
      RETRO_DISPATCH_TIMING.outcomeGraceMs;
    if (at > deadline)
      await note(
        dispatch.retroId,
        "unknown_outcome",
        "The runner has not reported past the execution limit. Its slot stays reserved until it reports a result or confirms teardown.",
      );
    else
      await note(dispatch.retroId, "active", "The runner is generating the retro.", {
        until: deadline,
      });
  }

  function signed(command: RunnerRetroCommand) {
    return options.sign(RunnerRetroCommandSchema.parse(command));
  }

  async function abandon(
    retro: Retro,
    state: "abandoned" | "coverage_failed",
    error: string,
    at: number,
  ) {
    await store.transaction((q) =>
      closeRetroSteps(q, { retroId: retro.id, state, error, now: at }),
    );
    await note(retro.id, "failed", error);
  }

  async function place(retro: Retro) {
    const at = now();
    const profile = profileOf(retro);
    if (profile.model === null || profile.model === undefined)
      return abandon(retro, "abandoned", "The retro has no frozen model.", at);
    const { maxAttempts, notStarted, activeExecutionMs } = await store.run((q) =>
      budgetSteps(q, retro),
    );
    const digest = await readDigest(store, root, retro);
    if (digest === null)
      return abandon(retro, "coverage_failed", "The frozen digest is unreadable.", at);
    if (!retroNeedsGeneration(digest)) {
      const started = await store.transaction(function* (q) {
        return (yield* openRetroDispatchSteps(q, retro.id)) === null
          ? yield* startRetroAttemptForSteps(
              q,
              retro,
              LOCAL_OWNER,
              at,
              60_000,
              maxAttempts + notStarted,
            )
          : null;
      });
      if (started === null) return;
      const settled = await settleRetroAttempt(store, root, {
        retroId: retro.id,
        attempt: started,
        owner: LOCAL_OWNER,
        output: null,
        now: at,
      });
      if (settled.ok) await note(retro.id, "ready", "No session activity in this window.");
      else await store.transaction((q) => afterFailureSteps(q, retro.id));
      return;
    }
    const { candidates, incompatible } = await retroRunnerCandidates(store, {
      workspaceId: retro.workspaceId,
      agent: profile.agent,
      now: at,
    });
    if (candidates.length === 0)
      return note(
        retro.id,
        "no_runner",
        incompatible > 0
          ? `No paired admin runner can run ${profile.agent} retros yet. ${incompatible} need a runner update.`
          : `No online paired admin runner has ${profile.agent} signed in.`,
      );
    const agent = profile.agent as RunnerCodingAgent;
    const accountId = (await store.run((q) => admitAgentAccountsSteps(q, retro.workspaceId, agent)))
      .eligible[0];
    if (accountId === undefined)
      return note(
        retro.id,
        "no_runner",
        `The workspace's default ${profile.agent} account is not enabled.`,
      );
    const heldSteps = (q: Q, runnerId: string) =>
      accountHealthHoldSteps(q, runnerId, accountId, profile.model, at);
    const holds: HealthHold[] = [];
    for (const runner of candidates) holds.push(await store.run((q) => heldSteps(q, runner.id)));
    const healthy = candidates.filter((_, index) => holds[index] === null);
    if (healthy.length === 0) {
      const blocks = holds.filter((hold) => hold !== null);
      if (blocks.every((hold) => hold.reason === "exhausted")) {
        const until = Math.min(...blocks.map((hold) => hold.until ?? Number.MAX_SAFE_INTEGER));
        await note(
          retro.id,
          "quota_cooldown",
          `${profile.agent} is cooling down after its usage limit.`,
          {
            until: until === Number.MAX_SAFE_INTEGER ? null : until,
          },
        );
      } else
        await note(
          retro.id,
          "no_runner",
          `The ${profile.agent} account cannot run here: ${BINDING_REASON_TEXT[blocks.find((hold) => hold.reason !== "exhausted")!.reason]}.`,
        );
      return;
    }
    const available = healthy.filter((runner) => runner.cooldownUntil <= at);
    if (available.length === 0) {
      const until = Math.min(...healthy.map((runner) => runner.cooldownUntil));
      return note(
        retro.id,
        "quota_cooldown",
        `${profile.agent} is cooling down after its usage limit.`,
        { until },
      );
    }
    const free = available
      .filter((runner) => runner.free)
      .sort(
        (a, b) =>
          a.occupied / a.capacity - b.occupied / b.capacity ||
          a.lastUsedAt - b.lastUsedAt ||
          a.id.localeCompare(b.id),
      );
    if (free.length === 0)
      return note(
        retro.id,
        "capacity_wait",
        `${available.length} compatible runner${available.length === 1 ? " is" : "s are"} busy. Waiting for a free slot.`,
      );
    function* accountFullSteps(q: Q) {
      const limit = yield* agentAccountConcurrencySteps(q, accountId!);
      return limit !== null && (yield* accountSlotsInUseSteps(q, accountId!, now())) >= limit;
    }
    if (await store.run(accountFullSteps))
      return note(
        retro.id,
        "capacity_wait",
        `The ${profile.agent} account is at its concurrency limit. Waiting for a free slot.`,
      );
    const prompt = await freezeRenderedRetroPrompt(store, root, { retroId: retro.id, now: at });
    if (!prompt.ok) return abandon(retro, "abandoned", prompt.reason, at);
    const digestRecord = (await store.run((q) => retroArtifactSteps(q, retro.id, "digest")))!;
    const promptBytes = await attemptPrompt(store, retro, digest, prompt.prompt, retro.attempt + 1);
    const oversized = [
      oversizedInput("digest", digestRecord.sizeBytes, RUNNER_RETRO_LIMITS.digestBytes),
      oversizedInput("prompt", promptBytes.byteLength, RUNNER_RETRO_LIMITS.promptBytes),
    ].filter((message) => message !== null);
    if (oversized.length > 0) return abandon(retro, "abandoned", oversized.join(" "), at);
    const runner = free[0]!;
    const commandId = newRetroCommandId(at);
    const leaseMs =
      RETRO_DISPATCH_TIMING.commandTtlMs + activeExecutionMs + RETRO_DISPATCH_TIMING.outcomeGraceMs;
    try {
      await store.transaction((q) => dispatchToSteps(q, runner.id));
    } catch (error) {
      if (!(error instanceof AgentAccountError)) throw error;
      await note(
        retro.id,
        "no_runner",
        `The ${profile.agent} account cannot run here: ${error.message}.`,
      );
    }
    function* dispatchToSteps(q: Q, runnerId: string) {
      const current = yield* getRetroSteps(q, retro.id);
      const identity = yield* runnerIdentitySteps(q, runnerId);
      if (
        current === null ||
        current.attempt !== retro.attempt ||
        current.state !== retro.state ||
        (yield* openRetroDispatchSteps(q, retro.id)) !== null ||
        identity === null ||
        identity.workspaceId !== retro.workspaceId ||
        !(yield* runnerHasWorkspaceAuthoritySteps(q, identity)) ||
        (yield* heldSteps(q, runnerId)) !== null ||
        (yield* accountFullSteps(q)) ||
        !(yield* runnerHasCapacitySteps(
          q,
          runnerId,
          at,
          "",
          (yield* runnerSlotsHeldBetweenCommandsSteps(q, runnerId, at)) +
            (yield* pinnedSlotsReservedSteps(q, runnerId, "", at)),
        ))
      )
        return;
      const attempt = yield* startRetroAttemptForSteps(
        q,
        retro,
        owner(commandId),
        at,
        leaseMs,
        maxAttempts + notStarted,
      );
      if (attempt === null) return;
      const command: RunnerRetroCommand = {
        id: commandId,
        runnerId,
        workspaceId: retro.workspaceId,
        issuedAt: at,
        expiresAt: at + RETRO_DISPATCH_TIMING.commandTtlMs,
        type: "retro",
        capability: RUNNER_RETRO_CAPABILITY,
        retroId: retro.id,
        attempt,
        settingsRevision: retro.settingsRevision,
        profile: {
          agent: profile.agent,
          model: profile.model,
          ...(profile.effort ? { effort: profile.effort } : {}),
        },
        executionLimit: { activeMinutes: activeExecutionMs / 60_000 },
        output: {
          maxItems: Number(retro.outputLimits.maxItems),
          workedWell: Number(retro.outputLimits.workedWell),
          maxChars: MAX_OUTPUT_CHARS,
        },
        digest: {
          kind: "digest",
          workspaceId: retro.workspaceId,
          retroId: retro.id,
          sha256: digestRecord.sha256,
          sizeBytes: digestRecord.sizeBytes,
        },
        prompt: {
          kind: "prompt",
          workspaceId: retro.workspaceId,
          retroId: retro.id,
          sha256: sha256(promptBytes),
          sizeBytes: promptBytes.byteLength,
        },
      };
      const account = yield* recordCommandAccountSteps(q, command, at);
      if (account?.accountId !== accountId)
        throw new AgentAccountError("binding_mismatch", "The command ran under another account");
      yield* recordRetroDispatchSteps(q, {
        commandId,
        retroId: retro.id,
        attempt,
        workspaceId: retro.workspaceId,
        runnerId,
        runnerFence: identity.fence,
        command,
        envelope: signed(command),
        issuedAt: command.issuedAt,
        expiresAt: command.expiresAt,
        now: at,
      });
      yield* recordRetroGenerationSteps(q, {
        retroId: retro.id,
        diagnostic: "dispatched",
        detail: "Sent to a paired runner. Waiting for it to fetch the command.",
        now: at,
      });
    }
  }

  function* startRetroAttemptForSteps(
    q: Q,
    retro: Retro,
    attemptOwner: string,
    at: number,
    leaseMs: number,
    maxAttempts: number,
  ) {
    return (
      (yield* startRetroAttemptSteps(q, {
        retroId: retro.id,
        owner: attemptOwner,
        now: at,
        leaseMs,
        maxAttempts,
      }))?.attempt ?? null
    );
  }

  async function advance(retro: Retro) {
    const open = await store.run((q) => openRetroDispatchSteps(q, retro.id));
    if (open !== null) return observe(open);
    if (retro.state === "queued") return place(retro);
    if (retro.state === "generating") {
      if (retro.owner === LOCAL_OWNER && (retro.ownerExpiresAt ?? 0) <= now()) await place(retro);
      return;
    }
    if (retro.state === "failed") {
      const at = await store.run((q) => retryAtSteps(q, retro));
      if (at === null) return note(retro.id, "failed", retro.error ?? "Retries are spent.");
      if (at > now())
        return note(retro.id, "retry_backoff", retro.error ?? "The attempt failed.", { until: at });
      return place(retro);
    }
  }

  async function inputBytes(retro: Retro, kind: "digest" | "prompt", attempt: number) {
    const stored = await store.run((q) => readRetroArtifactSteps(q, root, retro.id, kind));
    if (!stored.ok) return null;
    if (kind === "digest") return stored.bytes;
    const digest = await readDigest(store, root, retro);
    if (digest === null) return null;
    return attemptPrompt(store, retro, digest, new TextDecoder().decode(stored.bytes), attempt);
  }

  function* authorizeSteps(q: Q, runnerId: string, commandId: string, terminal = false) {
    const dispatch = yield* getRetroDispatchSteps(q, commandId);
    if (dispatch === null || dispatch.runnerId !== runnerId)
      throw new RetroFencedError("Retro command is not assigned to this runner");
    const identity = yield* runnerIdentitySteps(q, runnerId);
    if (
      identity === null ||
      identity.revokedAt !== null ||
      identity.status === "revoked" ||
      identity.fence !== dispatch.runnerFence ||
      identity.workspaceId !== dispatch.workspaceId ||
      (!terminal && !(yield* runnerHasWorkspaceAuthoritySteps(q, identity)))
    )
      throw new RetroFencedError("Runner retro authority changed");
    return dispatch;
  }

  const api = {
    async tick() {
      for (const id of await store.run(retrosToAdvanceSteps)) {
        try {
          const retro = await store.run((q) => getRetroSteps(q, id));
          if (retro !== null) await advance(retro);
        } catch (error) {
          journalCaught(error, "retros.dispatch.tick", null);
        }
      }
    },
    async cancel(retroId: string, reason: string) {
      const at = now();
      await store.transaction((q) =>
        closeRetroSteps(q, { retroId, state: "abandoned", error: reason, now: at }),
      );
      const open = await store.run((q) => openRetroDispatchSteps(q, retroId));
      if (open !== null && open.releasedAt === null) {
        await store.run((q) => requestRetroDispatchCancelSteps(q, open.commandId, at));
        await observe((await store.run((q) => getRetroDispatchSteps(q, open.commandId)))!);
      }
      await note(retroId, "failed", reason);
    },
    generation: (retroId: string) => store.run((q) => retroGenerationViewSteps(q, retroId)),
    async commands(runnerId: string): Promise<SignedRunnerCommand[]> {
      const envelopes: SignedRunnerCommand[] = [];
      for (const listed of await store.run((q) => deliverableRetroDispatchesSteps(q, runnerId))) {
        try {
          const envelope = await store.transaction(function* (q) {
            const dispatch = yield* authorizeSteps(q, runnerId, listed.commandId);
            const at = now();
            if (dispatch.releasedAt !== null || dispatch.cancelRequestedAt !== null) return null;
            if (
              dispatch.fetchedAt === null &&
              dispatch.expiresAt - at < RETRO_DISPATCH_TIMING.resignBeforeMs
            ) {
              const command = {
                ...(dispatch.command as RunnerRetroCommand),
                issuedAt: at,
                expiresAt: at + RETRO_DISPATCH_TIMING.commandTtlMs,
              };
              const fresh = signed(command);
              const resigned = yield* resignRetroDispatchSteps(q, {
                commandId: dispatch.commandId,
                envelope: fresh,
                issuedAt: command.issuedAt,
                expiresAt: command.expiresAt,
              });
              if (!resigned) return null;
              yield* markRetroDispatchFetchedSteps(q, dispatch.commandId, at);
              return fresh;
            }
            if (dispatch.expiresAt <= at) return null;
            yield* markRetroDispatchFetchedSteps(q, dispatch.commandId, at);
            return dispatch.envelope as SignedRunnerCommand;
          });
          if (envelope !== null) envelopes.push(envelope);
        } catch (error) {
          if (!(error instanceof RetroFencedError)) throw error;
          journalCaught(error, "retros.dispatch.commands", null);
        }
      }
      return envelopes;
    },
    async acknowledge(runnerId: string, commandId: string) {
      await store.transaction(function* (q) {
        const dispatch = yield* authorizeSteps(q, runnerId, commandId);
        if (dispatch.acknowledgedAt !== null) return;
        if (
          dispatch.expiresAt <= now() ||
          !(yield* acknowledgeRetroDispatchSteps(q, commandId, now()))
        )
          throw new RetroFencedError("Retro command is no longer valid");
      });
      const dispatch = (await store.run((q) => getRetroDispatchSteps(q, commandId)))!;
      await observe(dispatch);
      return { expiresAt: dispatch.expiresAt };
    },
    async input(runnerId: string, commandId: string, request: unknown) {
      const dispatch = await store.run((q) => authorizeSteps(q, runnerId, commandId));
      const retro = await store.run((q) => getRetroSteps(q, dispatch.retroId));
      if (
        retro === null ||
        retro.state !== "generating" ||
        dispatch.releasedAt !== null ||
        dispatch.acknowledgedAt === null
      )
        throw new RetroFencedError("Retro inputs are no longer available");
      const command = dispatch.command as RunnerRetroCommand;
      const grant = runnerRetroInputGrant(
        command,
        dispatch.acknowledgedAt +
          command.executionLimit.activeMinutes * 60_000 +
          RETRO_DISPATCH_TIMING.commandTtlMs,
      );
      const authorized = authorizeRetroInput(grant, {
        runnerId,
        request,
        currentAttempt: retro.attempt,
        now: now(),
      });
      if (!authorized.ok) {
        if (authorized.reason === "invalid_request" || authorized.reason === "out_of_range")
          throw new Error(`Retro input request refused: ${authorized.reason}`);
        throw new RetroFencedError(`Retro input refused: ${authorized.reason}`);
      }
      const { kind, offset, length, sha256: expected } = authorized.request;
      if (authorized.request.commandId !== commandId)
        throw new RetroFencedError("Retro input command changed");
      const bytes = await inputBytes(retro, kind, dispatch.attempt);
      if (bytes === null || sha256(bytes) !== expected)
        throw new RetroFencedError(`The frozen retro ${kind} is unreadable`);
      const chunk = bytes.subarray(offset, offset + length);
      return {
        commandId,
        kind,
        offset,
        sha256: sha256(chunk),
        data: Buffer.from(chunk).toString("base64"),
      };
    },
    async submit(runnerId: string, commandId: string, body: unknown) {
      const dispatch = await store.run((q) => authorizeSteps(q, runnerId, commandId, true));
      const retro = await store.run((q) => getRetroSteps(q, dispatch.retroId));
      const accepted = acceptRetroResult(dispatch.command as RunnerRetroCommand, {
        body,
        currentAttempt: retro?.attempt ?? -1,
        outputSha256: sha256,
      });
      if (!accepted.ok) {
        if (accepted.reason === "stale_attempt")
          throw new RetroFencedError("Retro result is for an earlier attempt");
        throw new Error(`Retro result refused: ${accepted.reason}`);
      }
      const recorded = await store.transaction((q) =>
        recordRetroDispatchResultSteps(q, { commandId, result: accepted.result, now: now() }),
      );
      if (recorded === "conflict") throw new RetroFencedError("A different result is recorded");
      if (recorded === "released") throw new RetroFencedError("Retro command was released");
      const stored = (await store.run((q) => getRetroDispatchSteps(q, commandId)))!;
      if (stored.settledAt === null) await settle(stored);
      return { duplicate: recorded === "duplicate" };
    },
    async released(runnerId: string, commandId: string) {
      await store.transaction(function* (q) {
        const dispatch = yield* authorizeSteps(q, runnerId, commandId, true);
        if (dispatch.releasedAt !== null) return;
        yield* releaseRetroDispatchSteps(q, {
          commandId,
          reason: dispatch.acknowledgedAt === null ? "not_started" : "teardown",
          now: now(),
        });
      });
      const dispatch = (await store.run((q) => getRetroDispatchSteps(q, commandId)))!;
      if (dispatch.settledAt === null) await settle(dispatch);
      return { ok: true };
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "cache-control": "no-store" } });
      try {
        if (path === "/v1/retro-commands" && request.method === "GET")
          return json({ commands: await api.commands(runnerId) });
        const match = /^\/v1\/retro-commands\/([^/]+)\/(ack|input|result|released)$/.exec(path);
        if (!match || request.method !== "POST") return null;
        const commandId = z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
          .parse(decodeURIComponent(match[1]!));
        const input = await boundedJson(request);
        switch (match[2]) {
          case "ack":
            z.strictObject({}).parse(input);
            return json(await api.acknowledge(runnerId, commandId));
          case "input":
            return json(await api.input(runnerId, commandId, input));
          case "result":
            return json(await api.submit(runnerId, commandId, input));
          default:
            z.strictObject({ reason: z.literal("teardown") }).parse(input);
            return json(await api.released(runnerId, commandId));
        }
      } catch (error) {
        journalCaught(error, "retros.dispatch.fetch", null);
        if (error instanceof RetroFencedError)
          return json({ error: "Retro command is fenced.", code: "fenced" }, 409);
        if (runnerRequestUnavailable(error))
          return json({ error: "Paws is busy. Retry the request." }, 503);
        return json({ error: "Retro request is denied or invalid." }, 403);
      }
    },
  };
  return api;
}

async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RUNNER_RESULT_BODY_LIMIT) throw new Error("Retro request is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const timeout = AbortSignal.timeout(10_000);
  try {
    while (true) {
      timeout.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RUNNER_RESULT_BODY_LIMIT) throw new Error("Retro request is too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export type RetroDispatcher = ReturnType<typeof createRetroDispatcher>;
