import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { journalCaught } from "../journal";
import {
  accountSlotsInUse,
  acknowledgeRetroDispatch,
  admitAgentAccounts,
  AgentAccountError,
  agentAccountConcurrency,
  closeRetro,
  deliverableRetroDispatches,
  failRetroAttempt,
  getRetro,
  getRetroDispatch,
  immediate,
  listRetroAttempts,
  listWorkspaceMembers,
  markRetroDispatchFetched,
  newRetroCommandId,
  openRetroDispatch,
  pinnedSlotsReserved,
  readRetroArtifact,
  recordCommandAccount,
  recordRetroDispatch,
  recordRetroDispatchResult,
  recordRetroGeneration,
  releaseRetroDispatch,
  requestRetroDispatchCancel,
  resignRetroDispatch,
  RETRO_WAIT_DIAGNOSTICS,
  retroArtifact,
  retroDispatchesNotStarted,
  retroGeneration,
  runnerHasCapacity,
  runnerOccupancy,
  runnerSlotsHeldBetweenCommands,
  settleRetroDispatch,
  startRetroAttempt,
  workspaceMember,
  type Retro,
  type RetroDispatch,
  type RetroGenerationDiagnostic,
} from "../db";
import { eligibleRunners, type EligibleRunner } from "../runner-placement";
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
import { freezeRenderedRetroPrompt } from "./prompt";
import { RETRO_RESULT_LIMITS, retroNeedsGeneration, settleRetroAttempt } from "./result";
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

export function retroRetryDelayMs(attemptsUsed: number): number {
  const exponent = Math.max(0, attemptsUsed - 1);
  return Math.min(
    RETRO_DISPATCH_TIMING.retryCapMs,
    RETRO_DISPATCH_TIMING.retryBaseMs * 2 ** Math.min(exponent, 16),
  );
}

function budget(db: Database, retro: Retro) {
  const notStarted = retroDispatchesNotStarted(db, retro.id);
  const { maxAttempts, activeExecutionMs } = retroAttemptLimits(retro.executionLimits);
  return { notStarted, maxAttempts, activeExecutionMs, used: retro.attempt - notStarted };
}

function retryAt(db: Database, retro: Retro): number | null {
  if (retro.state !== "failed") return null;
  const { used, maxAttempts } = budget(db, retro);
  if (used >= maxAttempts) return null;
  if (openRetroDispatch(db, retro.id) !== null) return null;
  const last = listRetroAttempts(db, retro.id).at(-1);
  const notStarted =
    db
      .query<{ reason: string | null }, [string, number]>(
        "SELECT release_reason AS reason FROM retro_dispatch WHERE retro_id = ? AND attempt = ?",
      )
      .get(retro.id, retro.attempt)?.reason === "not_started";
  const finished = last?.finishedAt ?? retro.updatedAt;
  return finished + retroRetryDelayMs(notStarted ? retroDispatchesNotStarted(db, retro.id) : used);
}

export function retroGenerationView(db: Database, retroId: string): RetroGenerationView | null {
  const retro = getRetro(db, retroId);
  if (retro === null) return null;
  const row = retroGeneration(db, retroId);
  const { used, maxAttempts } = budget(db, retro);
  const dispatch =
    openRetroDispatch(db, retroId) ??
    db
      .query<{ commandId: string }, [string]>(
        "SELECT command_id AS commandId FROM retro_dispatch WHERE retro_id = ? ORDER BY attempt DESC LIMIT 1",
      )
      .get(retroId);
  const latest = dispatch === null ? null : getRetroDispatch(db, dispatch.commandId);
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
  const at = retryAt(db, retro);
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

type RunnerIdentity = {
  workspaceId: string;
  ownerId: string;
  status: string;
  fence: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
};

function runnerIdentity(db: Database, runnerId: string): RunnerIdentity | null {
  return db
    .query<RunnerIdentity, [string]>(
      `SELECT workspace_id AS workspaceId, owner_user_id AS ownerId, status, fence,
         revoked_at AS revokedAt, last_seen_at AS lastSeenAt FROM runner WHERE id = ?`,
    )
    .get(runnerId);
}

function runnerHasWorkspaceAuthority(db: Database, identity: RunnerIdentity): boolean {
  const member = workspaceMember(db, identity.workspaceId, identity.ownerId);
  return member !== null && member.active && isWorkspaceAdmin(member.role);
}

export function retroRunnerCandidates(
  db: Database,
  input: { workspaceId: string; agent: string; now: number },
): { candidates: Candidate[]; incompatible: number } {
  const admins = listWorkspaceMembers(db, input.workspaceId).filter(
    (member) => member.active === 1 && isWorkspaceAdmin(member.role),
  );
  const seen = new Set<string>();
  let incompatible = 0;
  const candidates: Candidate[] = [];
  for (const admin of admins) {
    const runners = eligibleRunners(db, {
      workspaceId: input.workspaceId,
      teamId: "",
      ownerUserId: admin.id,
      leadUserIds: [],
      agent: input.agent,
      purpose: "work",
      now: input.now,
    });
    for (const runner of runners) {
      if (!runner.eligible || runner.ownerId !== admin.id || seen.has(runner.id)) continue;
      seen.add(runner.id);
      const version = db
        .query<{ version: string | null }, [string]>(
          "SELECT runner_version AS version FROM runner_host_status WHERE runner_id = ?",
        )
        .get(runner.id)?.version;
      if (!runnerAcceptsRetro(version)) {
        incompatible += 1;
        continue;
      }
      const held =
        runnerSlotsHeldBetweenCommands(db, runner.id, input.now) +
        pinnedSlotsReserved(db, runner.id, "", input.now);
      const { occupied, capacity } = runnerOccupancy(db, runner.id, input.now);
      candidates.push({
        ...runner,
        occupied: occupied + held,
        capacity,
        free: runnerHasCapacity(db, runner.id, input.now, "", held),
      });
    }
  }
  return { candidates, incompatible };
}

function profileOf(retro: Retro): RetroAgentProfile {
  return retro.agentProfile as RetroAgentProfile;
}

function readDigest(db: Database, root: string, retro: Retro): RetroDigest | null {
  const stored = readRetroArtifact(db, root, retro.id, "digest");
  if (!stored.ok || stored.artifact.sha256 !== retro.digestSha256) return null;
  return JSON.parse(new TextDecoder().decode(stored.bytes)) as RetroDigest;
}

export function createRetroDispatcher(options: {
  db: Database;
  artifactRoot: string;
  sign: RetroCommandSigner;
  now?: () => number;
}) {
  const { db, artifactRoot: root } = options;
  const now = options.now ?? Date.now;

  function note(
    retroId: string,
    diagnostic: RetroGenerationDiagnostic,
    detail: string,
    extra: { until?: number | null; activeMs?: number } = {},
  ) {
    recordRetroGeneration(db, { retroId, diagnostic, detail, now: now(), ...extra });
  }

  function afterFailure(retroId: string) {
    const retro = getRetro(db, retroId);
    if (retro === null) return;
    if (retro.state !== "failed") {
      if (retro.state === "abandoned" || retro.state === "coverage_failed")
        note(retroId, "failed", retro.error ?? "The retro was closed.");
      return;
    }
    const at = retryAt(db, retro);
    if (at === null) note(retroId, "failed", retro.error ?? "The retro could not be generated.");
    else
      note(retroId, "retry_backoff", retro.error ?? "The attempt failed.", {
        until: Math.max(at, now()),
      });
  }

  function settle(released: RetroDispatch) {
    immediate(db, () => {
      const dispatch = getRetroDispatch(db, released.commandId);
      if (dispatch === null || dispatch.releasedAt === null || dispatch.settledAt !== null) return;
      settleOnce(dispatch);
    });
  }

  function settleOnce(dispatch: RetroDispatch) {
    const at = now();
    const fail = (error: string) =>
      failRetroAttempt(db, {
        retroId: dispatch.retroId,
        attempt: dispatch.attempt,
        owner: owner(dispatch.commandId),
        error: error.slice(0, 2000),
        now: at,
      });
    const result = dispatch.result as RunnerRetroResult | null;
    if (dispatch.releaseReason === "result" && result !== null) {
      const retro = getRetro(db, dispatch.retroId);
      if (retro?.state === "generating" && retro.attempt === dispatch.attempt)
        recordRetroGeneration(db, {
          retroId: dispatch.retroId,
          diagnostic: "active",
          detail: `The runner reported ${result.outcome}.`,
          now: at,
          activeMs: result.activeMs,
        });
      const identity = runnerIdentity(db, dispatch.runnerId);
      if (identity === null || !runnerHasWorkspaceAuthority(db, identity))
        fail("The runner's owner lost workspace authority before the result arrived.");
      else if (result.outcome === "completed") {
        const settled = settleRetroAttempt(db, root, {
          retroId: dispatch.retroId,
          attempt: dispatch.attempt,
          owner: owner(dispatch.commandId),
          output: result.output ?? null,
          now: at,
        });
        if (settled.ok) note(dispatch.retroId, "ready", "The retro report is published.");
        else if (settled.reason === "coverage_gap")
          closeRetro(db, {
            retroId: dispatch.retroId,
            state: "coverage_failed",
            error: "The retro has a coverage gap and cannot be published.",
            now: at,
          });
        else if (settled.reason === "watermark_moved")
          closeRetro(db, {
            retroId: dispatch.retroId,
            state: "abandoned",
            error: "Another retro already published activity from this window.",
            now: at,
          });
        else if (settled.reason === "unknown_evidence" || settled.reason === "duplicate_item")
          fail(`The result did not match its evidence: ${settled.reason}.`);
      } else {
        const message = result.errorMessage ?? `The retro turn ended with ${result.outcome}.`;
        fail(`${result.outcome}: ${message}`);
      }
    } else if (dispatch.releaseReason === "not_started")
      fail("The runner did not start the retro command.");
    else if (dispatch.releaseReason === "teardown")
      fail("The runner ended the retro turn without a result.");
    settleRetroDispatch(db, dispatch.commandId, at);
    afterFailure(dispatch.retroId);
  }

  function observe(dispatch: RetroDispatch) {
    const at = now();
    if (dispatch.releasedAt !== null) return settle(dispatch);
    const identity = runnerIdentity(db, dispatch.runnerId);
    const fenced =
      identity === null ||
      identity.revokedAt !== null ||
      identity.status === "revoked" ||
      identity.fence !== dispatch.runnerFence;
    const authorized = !fenced && runnerHasWorkspaceAuthority(db, identity);
    if (!authorized && dispatch.fetchedAt === null && dispatch.acknowledgedAt === null) {
      releaseRetroDispatch(db, { commandId: dispatch.commandId, reason: "not_started", now: at });
      return settle(getRetroDispatch(db, dispatch.commandId)!);
    }
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
      if (dispatch.cancelRequestedAt !== null && dispatch.fetchedAt === null) {
        releaseRetroDispatch(db, { commandId: dispatch.commandId, reason: "not_started", now: at });
        return settle(getRetroDispatch(db, dispatch.commandId)!);
      }
      if (dispatch.fetchedAt === null && dispatch.expiresAt <= at) {
        releaseRetroDispatch(db, { commandId: dispatch.commandId, reason: "not_started", now: at });
        return settle(getRetroDispatch(db, dispatch.commandId)!);
      }
      if (dispatch.fetchedAt !== null && dispatch.expiresAt <= at && seenAfterExpiry) {
        releaseRetroDispatch(db, { commandId: dispatch.commandId, reason: "not_started", now: at });
        return settle(getRetroDispatch(db, dispatch.commandId)!);
      }
      note(
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
      note(
        dispatch.retroId,
        "unknown_outcome",
        "The runner has not reported past the execution limit. Its slot stays reserved until it reports a result or confirms teardown.",
      );
    else
      note(dispatch.retroId, "active", "The runner is generating the retro.", { until: deadline });
  }

  function signed(command: RunnerRetroCommand) {
    return options.sign(RunnerRetroCommandSchema.parse(command));
  }

  function place(retro: Retro) {
    const at = now();
    const profile = profileOf(retro);
    if (profile.model === null || profile.model === undefined) {
      closeRetro(db, {
        retroId: retro.id,
        state: "abandoned",
        error: "The retro has no frozen model.",
        now: at,
      });
      note(retro.id, "failed", "The retro has no frozen model.");
      return;
    }
    const { maxAttempts, notStarted, activeExecutionMs } = budget(db, retro);
    const digest = readDigest(db, root, retro);
    if (digest === null) {
      closeRetro(db, {
        retroId: retro.id,
        state: "coverage_failed",
        error: "The frozen digest is unreadable.",
        now: at,
      });
      note(retro.id, "failed", "The frozen digest is unreadable.");
      return;
    }
    if (!retroNeedsGeneration(digest)) {
      const started = immediate(db, () =>
        openRetroDispatch(db, retro.id) === null
          ? startRetroAttemptFor(retro, LOCAL_OWNER, at, 60_000, maxAttempts + notStarted)
          : null,
      );
      if (started === null) return;
      const settled = settleRetroAttempt(db, root, {
        retroId: retro.id,
        attempt: started,
        owner: LOCAL_OWNER,
        output: null,
        now: at,
      });
      if (settled.ok) note(retro.id, "ready", "No session activity in this window.");
      else afterFailure(retro.id);
      return;
    }
    const { candidates, incompatible } = retroRunnerCandidates(db, {
      workspaceId: retro.workspaceId,
      agent: profile.agent,
      now: at,
    });
    if (candidates.length === 0) {
      note(
        retro.id,
        "no_runner",
        incompatible > 0
          ? `No paired admin runner can run ${profile.agent} retros yet. ${incompatible} need a runner update.`
          : `No online paired admin runner has ${profile.agent} signed in.`,
      );
      return;
    }
    const available = candidates.filter((runner) => runner.cooldownUntil <= at);
    if (available.length === 0) {
      const until = Math.min(...candidates.map((runner) => runner.cooldownUntil));
      note(retro.id, "quota_cooldown", `${profile.agent} is cooling down after its usage limit.`, {
        until,
      });
      return;
    }
    const free = available
      .filter((runner) => runner.free)
      .sort(
        (a, b) =>
          a.occupied / a.capacity - b.occupied / b.capacity ||
          a.lastUsedAt - b.lastUsedAt ||
          a.id.localeCompare(b.id),
      );
    if (free.length === 0) {
      note(
        retro.id,
        "capacity_wait",
        `${available.length} compatible runner${available.length === 1 ? " is" : "s are"} busy. Waiting for a free slot.`,
      );
      return;
    }
    const agent = profile.agent as RunnerCodingAgent;
    const accountId = admitAgentAccounts(db, retro.workspaceId, agent).eligible[0];
    if (accountId === undefined) {
      note(
        retro.id,
        "no_runner",
        `The workspace's default ${profile.agent} account is not enabled.`,
      );
      return;
    }
    const accountFull = () => {
      const limit = agentAccountConcurrency(db, accountId);
      return limit !== null && accountSlotsInUse(db, accountId, now()) >= limit;
    };
    if (accountFull()) {
      note(
        retro.id,
        "capacity_wait",
        `The ${profile.agent} account is at its concurrency limit. Waiting for a free slot.`,
      );
      return;
    }
    const prompt = freezeRenderedRetroPrompt(db, root, { retroId: retro.id, now: at });
    if (!prompt.ok) {
      closeRetro(db, { retroId: retro.id, state: "abandoned", error: prompt.reason, now: at });
      note(retro.id, "failed", prompt.reason);
      return;
    }
    const digestRecord = retroArtifact(db, retro.id, "digest")!;
    const promptRecord = retroArtifact(db, retro.id, "prompt")!;
    if (
      digestRecord.sizeBytes > RUNNER_RETRO_LIMITS.digestBytes ||
      promptRecord.sizeBytes > RUNNER_RETRO_LIMITS.promptBytes
    ) {
      const error = "The frozen retro inputs exceed the runner limits.";
      closeRetro(db, { retroId: retro.id, state: "abandoned", error, now: at });
      note(retro.id, "failed", error);
      return;
    }
    const runner = free[0]!;
    const commandId = newRetroCommandId(at);
    const leaseMs =
      RETRO_DISPATCH_TIMING.commandTtlMs + activeExecutionMs + RETRO_DISPATCH_TIMING.outcomeGraceMs;
    try {
      immediate(db, () => dispatchTo(runner.id));
    } catch (error) {
      if (!(error instanceof AgentAccountError)) throw error;
      note(
        retro.id,
        "no_runner",
        `The ${profile.agent} account cannot run here: ${error.message}.`,
      );
    }
    function dispatchTo(runnerId: string) {
      const current = getRetro(db, retro.id);
      const identity = runnerIdentity(db, runnerId);
      if (
        current === null ||
        current.attempt !== retro.attempt ||
        current.state !== retro.state ||
        openRetroDispatch(db, retro.id) !== null ||
        identity === null ||
        identity.workspaceId !== retro.workspaceId ||
        !runnerHasWorkspaceAuthority(db, identity) ||
        accountFull() ||
        !runnerHasCapacity(
          db,
          runnerId,
          at,
          "",
          runnerSlotsHeldBetweenCommands(db, runnerId, at) +
            pinnedSlotsReserved(db, runnerId, "", at),
        )
      )
        return;
      const attempt = startRetroAttemptFor(
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
          sha256: promptRecord.sha256,
          sizeBytes: promptRecord.sizeBytes,
        },
      };
      const account = recordCommandAccount(db, command, at);
      if (account?.accountId !== accountId)
        throw new AgentAccountError("binding_mismatch", "The command ran under another account");
      recordRetroDispatch(db, {
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
      recordRetroGeneration(db, {
        retroId: retro.id,
        diagnostic: "dispatched",
        detail: "Sent to a paired runner. Waiting for it to fetch the command.",
        now: at,
      });
    }
  }

  function startRetroAttemptFor(
    retro: Retro,
    attemptOwner: string,
    at: number,
    leaseMs: number,
    maxAttempts: number,
  ): number | null {
    return (
      startRetroAttempt(db, {
        retroId: retro.id,
        owner: attemptOwner,
        now: at,
        leaseMs,
        maxAttempts,
      })?.attempt ?? null
    );
  }

  function advance(retro: Retro) {
    const open = openRetroDispatch(db, retro.id);
    if (open !== null) return observe(open);
    if (retro.state === "queued") return place(retro);
    if (retro.state === "generating") {
      if (retro.owner === LOCAL_OWNER && (retro.ownerExpiresAt ?? 0) <= now()) place(retro);
      return;
    }
    if (retro.state === "failed") {
      const at = retryAt(db, retro);
      if (at === null) return note(retro.id, "failed", retro.error ?? "Retries are spent.");
      if (at > now())
        return note(retro.id, "retry_backoff", retro.error ?? "The attempt failed.", { until: at });
      return place(retro);
    }
  }

  function authorize(runnerId: string, commandId: string, terminal = false) {
    const dispatch = getRetroDispatch(db, commandId);
    if (dispatch === null || dispatch.runnerId !== runnerId)
      throw new RetroFencedError("Retro command is not assigned to this runner");
    const identity = runnerIdentity(db, runnerId);
    if (
      identity === null ||
      identity.revokedAt !== null ||
      identity.status === "revoked" ||
      identity.fence !== dispatch.runnerFence ||
      identity.workspaceId !== dispatch.workspaceId ||
      (!terminal && !runnerHasWorkspaceAuthority(db, identity))
    )
      throw new RetroFencedError("Runner retro authority changed");
    return dispatch;
  }

  const api = {
    tick() {
      const rows = db
        .query<{ id: string }, []>(
          `SELECT id FROM retro WHERE (state IN ('queued','generating','failed')
             AND id NOT IN (SELECT retro_id FROM retro_generation WHERE diagnostic = 'failed'))
           OR id IN (SELECT retro_id FROM retro_dispatch WHERE released_at IS NULL OR settled_at IS NULL)
           ORDER BY created_at, id`,
        )
        .all();
      for (const { id } of rows) {
        try {
          const retro = getRetro(db, id);
          if (retro !== null) advance(retro);
        } catch (error) {
          journalCaught(error, "retros.dispatch.tick", null);
        }
      }
    },
    cancel(retroId: string, reason: string) {
      const at = now();
      closeRetro(db, { retroId, state: "abandoned", error: reason, now: at });
      const open = openRetroDispatch(db, retroId);
      if (open !== null && open.releasedAt === null) {
        requestRetroDispatchCancel(db, open.commandId, at);
        observe(getRetroDispatch(db, open.commandId)!);
      }
      note(retroId, "failed", reason);
    },
    generation: (retroId: string) => retroGenerationView(db, retroId),
    commands(runnerId: string): SignedRunnerCommand[] {
      const envelopes: SignedRunnerCommand[] = [];
      for (const listed of deliverableRetroDispatches(db, runnerId)) {
        try {
          const envelope = immediate(db, () => {
            const dispatch = authorize(runnerId, listed.commandId);
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
              const resigned = resignRetroDispatch(db, {
                commandId: dispatch.commandId,
                envelope: fresh,
                issuedAt: command.issuedAt,
                expiresAt: command.expiresAt,
              });
              if (!resigned) return null;
              markRetroDispatchFetched(db, dispatch.commandId, at);
              return fresh;
            }
            if (dispatch.expiresAt <= at) return null;
            markRetroDispatchFetched(db, dispatch.commandId, at);
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
    acknowledge(runnerId: string, commandId: string) {
      immediate(db, () => {
        const dispatch = authorize(runnerId, commandId);
        if (dispatch.acknowledgedAt !== null) return;
        if (dispatch.expiresAt <= now() || !acknowledgeRetroDispatch(db, commandId, now()))
          throw new RetroFencedError("Retro command is no longer valid");
      });
      const dispatch = getRetroDispatch(db, commandId)!;
      observe(dispatch);
      return { expiresAt: dispatch.expiresAt };
    },
    input(runnerId: string, commandId: string, request: unknown) {
      const dispatch = authorize(runnerId, commandId);
      const retro = getRetro(db, dispatch.retroId);
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
      const stored = readRetroArtifact(db, root, retro.id, kind);
      if (!stored.ok || stored.artifact.sha256 !== expected)
        throw new RetroFencedError(`The frozen retro ${kind} is unreadable`);
      const chunk = stored.bytes.subarray(offset, offset + length);
      return {
        commandId,
        kind,
        offset,
        sha256: sha256(chunk),
        data: Buffer.from(chunk).toString("base64"),
      };
    },
    submit(runnerId: string, commandId: string, body: unknown) {
      const dispatch = authorize(runnerId, commandId, true);
      const retro = getRetro(db, dispatch.retroId);
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
      const recorded = recordRetroDispatchResult(db, {
        commandId,
        result: accepted.result,
        now: now(),
      });
      if (recorded === "conflict") throw new RetroFencedError("A different result is recorded");
      if (recorded === "released") throw new RetroFencedError("Retro command was released");
      const stored = getRetroDispatch(db, commandId)!;
      if (stored.settledAt === null) settle(stored);
      return { duplicate: recorded === "duplicate" };
    },
    released(runnerId: string, commandId: string) {
      immediate(db, () => {
        const dispatch = authorize(runnerId, commandId, true);
        if (dispatch.releasedAt !== null) return;
        releaseRetroDispatch(db, {
          commandId,
          reason: dispatch.acknowledgedAt === null ? "not_started" : "teardown",
          now: now(),
        });
      });
      const dispatch = getRetroDispatch(db, commandId)!;
      if (dispatch.settledAt === null) settle(dispatch);
      return { ok: true };
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "cache-control": "no-store" } });
      try {
        if (path === "/v1/retro-commands" && request.method === "GET")
          return json({ commands: api.commands(runnerId) });
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
            return json(api.acknowledge(runnerId, commandId));
          case "input":
            return json(api.input(runnerId, commandId, input));
          case "result":
            return json(api.submit(runnerId, commandId, input));
          default:
            z.strictObject({ reason: z.literal("teardown") }).parse(input);
            return json(api.released(runnerId, commandId));
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
