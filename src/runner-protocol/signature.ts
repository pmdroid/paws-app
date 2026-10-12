import { sign, verify, type KeyObject } from "node:crypto";
import {
  RunnerCommandSchema,
  SignedRunnerCommandSchema,
  type RunnerCommand,
  type SignedRunnerCommand,
} from "./commands";

export type RunnerCommandRejection =
  | "invalid_envelope"
  | "untrusted_key"
  | "invalid_signature"
  | "invalid_payload"
  | "noncanonical_payload"
  | "identity_mismatch"
  | "not_yet_valid"
  | "expired"
  | "repository_denied"
  | "replayed"
  | "replay_unavailable";

export type RunnerCommandVerification =
  | { ok: true; command: RunnerCommand }
  | { ok: false; reason: RunnerCommandRejection };

export type RunnerCommandVerifier = {
  trustedKeys: ReadonlyMap<string, KeyObject>;
  runnerId: string;
  workspaceId: string;
  now: number;
  allowedRepositories: readonly string[];
  claimCommand: (id: string, expiresAt: number) => boolean;
};

export function signRunnerCommand(input: {
  keyId: string;
  privateKey: KeyObject;
  command: RunnerCommand;
}): SignedRunnerCommand {
  if (input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Runner command signing requires an Ed25519 private key");
  }
  const command = RunnerCommandSchema.parse(input.command);
  const bytes = Buffer.from(canonicalJson(command), "utf8");
  return SignedRunnerCommandSchema.parse({
    keyId: input.keyId,
    payload: bytes.toString("base64url"),
    signature: sign(null, bytes, input.privateKey).toString("base64url"),
  });
}

export function verifyRunnerCommand(
  envelope: unknown,
  context: RunnerCommandVerifier,
): RunnerCommandVerification {
  const parsed = SignedRunnerCommandSchema.safeParse(envelope);
  if (!parsed.success) return { ok: false, reason: "invalid_envelope" };
  const input = parsed.data;
  const key = context.trustedKeys.get(input.keyId);
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    return { ok: false, reason: "untrusted_key" };
  }
  const bytes = Buffer.from(input.payload, "base64url");
  const signature = Buffer.from(input.signature, "base64url");
  if (
    bytes.toString("base64url") !== input.payload ||
    signature.toString("base64url") !== input.signature ||
    signature.length !== 64
  )
    return { ok: false, reason: "invalid_envelope" };
  if (!verify(null, bytes, key, signature)) return { ok: false, reason: "invalid_signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
  const result = RunnerCommandSchema.safeParse(payload);
  if (!result.success) return { ok: false, reason: "invalid_payload" };
  const command = result.data;
  if (!Buffer.from(canonicalJson(command), "utf8").equals(bytes)) {
    return { ok: false, reason: "noncanonical_payload" };
  }
  if (command.runnerId !== context.runnerId || command.workspaceId !== context.workspaceId) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (!Number.isSafeInteger(context.now) || command.issuedAt > context.now) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (command.expiresAt <= context.now) return { ok: false, reason: "expired" };
  if (
    (command.type === "run" || command.type === "review") &&
    !context.allowedRepositories.some(
      (repository) =>
        repository.toLowerCase() ===
        `${command.repository.owner}/${command.repository.repo}`.toLowerCase(),
    )
  )
    return { ok: false, reason: "repository_denied" };
  try {
    if (!context.claimCommand(command.id, command.expiresAt)) {
      return { ok: false, reason: "replayed" };
    }
  } catch {
    return { ok: false, reason: "replay_unavailable" };
  }
  return { ok: true, command };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const object = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, object[key]]),
    );
  });
}
