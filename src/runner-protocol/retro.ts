import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { journalCaught } from "../journal";
import { RunnerAccountSchema, runnerAccountAgentUnsupported } from "./accounts";
import { RUNNER_INPUT_CHUNK_BYTES } from "./inputs";
import { runnerVersionAtLeast } from "./policy-keys";
import { RunnerProfileSchema, type SignedRunnerCommand } from "./commands";
import { canonicalJson, openSignedPayload, signPayload } from "./signature";
import { RETRO_RUNNER_VERSION } from "./versions";

export const RUNNER_RETRO_CAPABILITY = 1;

export const RUNNER_RETRO_LIMITS = {
  commandLifetimeMs: 600_000,
  activeMinutes: { min: 1, max: 120 },
  maxItems: { min: 1, max: 5 },
  workedWell: { min: 0, max: 3 },
  outputChars: 32_000,
  digestBytes: 8 * 1024 * 1024,
  promptBytes: 8 * 1024 * 1024 + 64 * 1024,
  errorChars: 4_096,
} as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attempt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const between = (range: { min: number; max: number }) =>
  z.number().int().min(range.min).max(range.max);

export const RUNNER_RETRO_INPUTS = ["digest", "prompt"] as const;
export type RunnerRetroInputKind = (typeof RUNNER_RETRO_INPUTS)[number];

export const RunnerRetroInputSchema = z
  .strictObject({
    kind: z.enum(RUNNER_RETRO_INPUTS),
    workspaceId: id,
    retroId: id,
    sha256,
    sizeBytes: z.number().int().min(1).max(RUNNER_RETRO_LIMITS.promptBytes),
  })
  .refine((input) => input.kind !== "digest" || input.sizeBytes <= RUNNER_RETRO_LIMITS.digestBytes);

export const RunnerRetroCommandSchema = z
  .strictObject({
    id,
    runnerId: id,
    workspaceId: id,
    issuedAt: time,
    expiresAt: time,
    type: z.literal("retro"),
    capability: z.literal(RUNNER_RETRO_CAPABILITY),
    retroId: id,
    attempt,
    settingsRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    profile: RunnerProfileSchema,
    account: RunnerAccountSchema.optional(),
    executionLimit: z.strictObject({ activeMinutes: between(RUNNER_RETRO_LIMITS.activeMinutes) }),
    output: z.strictObject({
      maxItems: between(RUNNER_RETRO_LIMITS.maxItems),
      workedWell: between(RUNNER_RETRO_LIMITS.workedWell),
      maxChars: z.number().int().min(1).max(RUNNER_RETRO_LIMITS.outputChars),
    }),
    digest: RunnerRetroInputSchema,
    prompt: RunnerRetroInputSchema,
  })
  .refine((command) => command.expiresAt > command.issuedAt)
  .refine(
    (command) => command.expiresAt - command.issuedAt <= RUNNER_RETRO_LIMITS.commandLifetimeMs,
  )
  .refine((command) => command.digest.kind === "digest" && command.prompt.kind === "prompt")
  .refine((command) =>
    [command.digest, command.prompt].every(
      (input) => input.workspaceId === command.workspaceId && input.retroId === command.retroId,
    ),
  );

export type RunnerRetroCommand = z.infer<typeof RunnerRetroCommandSchema>;
export type RunnerRetroInput = z.infer<typeof RunnerRetroInputSchema>;

export const RunnerRetroInputRequestSchema = z
  .strictObject({
    commandId: id,
    workspaceId: id,
    retroId: id,
    attempt,
    kind: z.enum(RUNNER_RETRO_INPUTS),
    sha256,
    offset: z.number().int().min(0).max(RUNNER_RETRO_LIMITS.promptBytes),
    length: z.number().int().min(1).max(RUNNER_INPUT_CHUNK_BYTES),
  })
  .refine((request) => request.offset + request.length <= RUNNER_RETRO_LIMITS.promptBytes);

export type RunnerRetroInputRequest = z.infer<typeof RunnerRetroInputRequestSchema>;

export type RunnerRetroInputGrant = {
  commandId: string;
  runnerId: string;
  workspaceId: string;
  retroId: string;
  attempt: number;
  expiresAt: number;
  inputs: Readonly<Record<RunnerRetroInputKind, { sha256: string; sizeBytes: number }>>;
};

export function runnerRetroInputGrant(
  command: RunnerRetroCommand,
  expiresAt: number,
): RunnerRetroInputGrant {
  return {
    commandId: command.id,
    runnerId: command.runnerId,
    workspaceId: command.workspaceId,
    retroId: command.retroId,
    attempt: command.attempt,
    expiresAt,
    inputs: {
      digest: { sha256: command.digest.sha256, sizeBytes: command.digest.sizeBytes },
      prompt: { sha256: command.prompt.sha256, sizeBytes: command.prompt.sizeBytes },
    },
  };
}

export type RunnerRetroInputDenial =
  | "invalid_request"
  | "identity_mismatch"
  | "stale_attempt"
  | "expired"
  | "input_mismatch"
  | "out_of_range";

export function authorizeRetroInput(
  grant: RunnerRetroInputGrant,
  input: { runnerId: string; request: unknown; currentAttempt: number; now: number },
): { ok: true; request: RunnerRetroInputRequest } | { ok: false; reason: RunnerRetroInputDenial } {
  const parsed = RunnerRetroInputRequestSchema.safeParse(input.request);
  if (!parsed.success) return { ok: false, reason: "invalid_request" };
  const request = parsed.data;
  if (
    input.runnerId !== grant.runnerId ||
    request.commandId !== grant.commandId ||
    request.workspaceId !== grant.workspaceId ||
    request.retroId !== grant.retroId ||
    request.attempt !== grant.attempt
  )
    return { ok: false, reason: "identity_mismatch" };
  if (grant.attempt !== input.currentAttempt) return { ok: false, reason: "stale_attempt" };
  if (input.now >= grant.expiresAt) return { ok: false, reason: "expired" };
  const granted = grant.inputs[request.kind];
  if (request.sha256 !== granted.sha256) return { ok: false, reason: "input_mismatch" };
  if (request.offset + request.length > granted.sizeBytes)
    return { ok: false, reason: "out_of_range" };
  return { ok: true, request };
}

export type RunnerRetroSlot = {
  kind: "retro";
  runnerId: string;
  workspaceId: string;
  retroId: string;
  attempt: number;
  commandId: string;
};

export const RUNNER_RETRO_SLOT_RELEASES = ["result", "expired", "cancelled", "teardown"] as const;
export type RunnerRetroSlotRelease = (typeof RUNNER_RETRO_SLOT_RELEASES)[number];

export function runnerRetroSlot(command: RunnerRetroCommand): RunnerRetroSlot {
  return {
    kind: "retro",
    runnerId: command.runnerId,
    workspaceId: command.workspaceId,
    retroId: command.retroId,
    attempt: command.attempt,
    commandId: command.id,
  };
}

export function runnerRetroSlotKey(slot: RunnerRetroSlot): string {
  return `retro:${slot.workspaceId}:${slot.retroId}:${slot.attempt}:${slot.commandId}`;
}

export const RunnerRetroResultSchema = z
  .strictObject({
    executionId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
    commandId: id,
    type: z.literal("retro"),
    capability: z.literal(RUNNER_RETRO_CAPABILITY),
    runnerId: id,
    workspaceId: id,
    retroId: id,
    attempt,
    settingsRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    digestSha256: sha256,
    promptSha256: sha256,
    outcome: z.enum(["completed", "timeout", "cancelled", "auth_required", "error"]),
    activeMs: z
      .number()
      .int()
      .min(0)
      .max(RUNNER_RETRO_LIMITS.activeMinutes.max * 60_000),
    output: z.string().min(1).max(RUNNER_RETRO_LIMITS.outputChars).optional(),
    outputSha256: sha256.optional(),
    errorMessage: z.string().min(1).max(RUNNER_RETRO_LIMITS.errorChars).optional(),
    identity: z
      .strictObject({ model: z.string().max(512), provider: z.string().max(512) })
      .optional(),
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((result) => (result.outcome === "completed") === (result.output !== undefined))
  .refine((result) => (result.output === undefined) === (result.outputSha256 === undefined))
  .refine((result) => result.outcome !== "completed" || result.errorMessage === undefined);

export type RunnerRetroResult = z.infer<typeof RunnerRetroResultSchema>;

export type RunnerRetroResultRejection =
  | "malformed"
  | "identity_mismatch"
  | "stale_attempt"
  | "over_limit";

export function acceptRetroResult(
  command: RunnerRetroCommand,
  input: { body: unknown; currentAttempt: number; outputSha256: (output: string) => string },
): { ok: true; result: RunnerRetroResult } | { ok: false; reason: RunnerRetroResultRejection } {
  const parsed = RunnerRetroResultSchema.safeParse(input.body);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const result = parsed.data;
  if (
    result.commandId !== command.id ||
    result.runnerId !== command.runnerId ||
    result.workspaceId !== command.workspaceId ||
    result.retroId !== command.retroId ||
    result.attempt !== command.attempt ||
    result.settingsRevision !== command.settingsRevision ||
    result.digestSha256 !== command.digest.sha256 ||
    result.promptSha256 !== command.prompt.sha256
  )
    return { ok: false, reason: "identity_mismatch" };
  if (command.attempt !== input.currentAttempt) return { ok: false, reason: "stale_attempt" };
  if (result.output !== undefined && result.outputSha256 !== input.outputSha256(result.output))
    return { ok: false, reason: "malformed" };
  if (
    (result.output?.length ?? 0) > command.output.maxChars ||
    result.activeMs > command.executionLimit.activeMinutes * 60_000
  )
    return { ok: false, reason: "over_limit" };
  return { ok: true, result };
}

export function runnerAcceptsRetro(version: string | null | undefined): boolean {
  return version != null && runnerVersionAtLeast(version, RETRO_RUNNER_VERSION);
}

export function signRunnerRetroCommand(input: {
  keyId: string;
  privateKey: KeyObject;
  command: RunnerRetroCommand;
}): SignedRunnerCommand {
  return signPayload(input.keyId, input.privateKey, RunnerRetroCommandSchema.parse(input.command));
}

export type RunnerRetroCommandRejection =
  | "invalid_envelope"
  | "untrusted_key"
  | "invalid_signature"
  | "invalid_payload"
  | "noncanonical_payload"
  | "identity_mismatch"
  | "not_yet_valid"
  | "expired"
  | "stale_attempt"
  | "account_unavailable"
  | "replayed"
  | "replay_unavailable";

export type RunnerRetroCommandVerifier = {
  trustedKeys: ReadonlyMap<string, KeyObject>;
  runnerId: string;
  workspaceId: string;
  now: number;
  accountBindings?: ReadonlySet<string>;
  latestAttempt: (retroId: string) => number | undefined;
  claimCommand: (id: string, expiresAt: number) => boolean;
};

export function verifyRunnerRetroCommand(
  envelope: unknown,
  context: RunnerRetroCommandVerifier,
): { ok: true; command: RunnerRetroCommand } | { ok: false; reason: RunnerRetroCommandRejection } {
  const opened = openSignedPayload(envelope, context.trustedKeys);
  if (!opened.ok) return opened;
  const parsed = RunnerRetroCommandSchema.safeParse(opened.payload);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  const command = parsed.data;
  if (!Buffer.from(canonicalJson(command), "utf8").equals(opened.bytes))
    return { ok: false, reason: "noncanonical_payload" };
  if (command.runnerId !== context.runnerId || command.workspaceId !== context.workspaceId)
    return { ok: false, reason: "identity_mismatch" };
  if (!Number.isSafeInteger(context.now) || command.issuedAt > context.now)
    return { ok: false, reason: "not_yet_valid" };
  if (command.expiresAt <= context.now) return { ok: false, reason: "expired" };
  const latest = context.latestAttempt(command.retroId);
  if (latest !== undefined && command.attempt <= latest)
    return { ok: false, reason: "stale_attempt" };
  if (
    command.account &&
    (runnerAccountAgentUnsupported(command.profile.agent) ||
      !context.accountBindings?.has(command.account.bindingId))
  )
    return { ok: false, reason: "account_unavailable" };
  try {
    if (!context.claimCommand(command.id, command.expiresAt))
      return { ok: false, reason: "replayed" };
  } catch (caughtError) {
    journalCaught(caughtError, "retro.verifyRunnerRetroCommand.claimCommand", null);
    return { ok: false, reason: "replay_unavailable" };
  }
  return { ok: true, command };
}
