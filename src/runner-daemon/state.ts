import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readSecretFile, writeSecretFile } from "../credentials";
import { createRunnerKey, describeRunnerCertificate } from "../runner-identity";

export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const SigningKeysSchema = z
  .array(
    z.strictObject({
      keyId: identifier,
      publicKeyPem: z
        .string()
        .max(4096)
        .refine((pem) => {
          try {
            if (!pem.startsWith("-----BEGIN PUBLIC KEY-----\n")) return false;
            const key = createPublicKey(pem);
            return (
              key.asymmetricKeyType === "ed25519" &&
              key.export({ type: "spki", format: "pem" }) === pem
            );
          } catch {
            return false;
          }
        }),
    }),
  )
  .min(1)
  .max(8)
  .refine((keys) => new Set(keys.map((key) => key.keyId)).size === keys.length);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const verifierFingerprint = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();
const common = {
  controlPlaneUrl: z.string(),
  runnerApiUrl: z.string(),
  csr: z.string().min(1).max(16_384),
};
export const PairingChallengeSchema = z.strictObject({
  id: identifier,
  claim: z
    .string()
    .min(16)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  code: z.string().regex(/^[A-F0-9]{16}$/),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  verifierFingerprint,
  expiresAt: timestamp,
});
export const ApprovedIdentitySchema = z.strictObject({
  runnerId: identifier,
  workspaceId: identifier,
  certificate: z.string().min(1).max(32_768),
  authority: z.string().min(1).max(32_768),
  signingKeys: SigningKeysSchema,
  verifierFingerprint,
});
const StateSchema = z.discriminatedUnion("phase", [
  z.strictObject({ ...common, phase: z.literal("prepared") }),
  z.strictObject({ ...common, phase: z.literal("pending"), ...PairingChallengeSchema.shape }),
  z.strictObject({
    ...common,
    phase: z.literal("paired"),
    ...ApprovedIdentitySchema.shape,
    signingKeys: SigningKeysSchema.optional(),
  }),
]);
export type RunnerState = z.infer<typeof StateSchema>;
export type PairedState = Extract<RunnerState, { phase: "paired" }>;
export type PairingChallenge = z.infer<typeof PairingChallengeSchema>;

export function trustedSigningKeys(
  state: PairedState,
  pins?: ReadonlyMap<string, KeyObject>,
): ReadonlyMap<string, KeyObject> {
  if (!state.signingKeys) {
    if (pins?.size) return pins;
    throw new Error("Runner job signing keys require authenticated renewal.");
  }
  const keys = new Map(
    state.signingKeys.map(({ keyId, publicKeyPem }) => [keyId, createPublicKey(publicKeyPem)]),
  );
  if (pins)
    for (const [id, key] of keys)
      if (!pins.get(id)?.equals(key))
        throw new Error("Runner job signing key does not match its pin.");
  return keys;
}

export function readRecovery(root: string, runnerId: string): PairingChallenge | null {
  const raw = readSecretFile(join(root, "identity", "recovery.json"));
  if (raw === null) return null;
  const recovery = z
    .strictObject({ runnerId: identifier, challenge: PairingChallengeSchema })
    .parse(JSON.parse(raw));
  return recovery.runnerId === runnerId ? recovery.challenge : null;
}

export function writeRecovery(root: string, runnerId: string, challenge: PairingChallenge): void {
  writeSecretFile(join(root, "identity", "recovery.json"), JSON.stringify({ runnerId, challenge }));
}

export function readState(root: string): RunnerState | null {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const raw = readSecretFile(join(root, "identity", "state.json"));
  return raw === null ? null : StateSchema.parse(JSON.parse(raw));
}

export function writeState(root: string, state: RunnerState): void {
  writeSecretFile(join(root, "identity", "state.json"), JSON.stringify(StateSchema.parse(state)));
}

export async function prepareState(
  root: string,
  origins: { controlPlaneUrl: string; runnerApiUrl: string },
): Promise<RunnerState> {
  const dir = mkdtempSync(join(root, ".identity-"));
  chmodSync(dir, 0o700);
  try {
    const { csr, keyPath } = await createRunnerKey(dir);
    writeSecretFile(keyPath, readFileSync(keyPath, "utf8"));
    const state: RunnerState = { ...origins, phase: "prepared", csr };
    writeSecretFile(join(dir, "state.json"), JSON.stringify(state));
    renameSync(dir, join(root, "identity"));
    const fd = openSync(root, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return state;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function localKey(root: string): string {
  const key = readSecretFile(join(root, "identity", "runner-key.pem"));
  if (!key) throw new Error("Runner private key is missing.");
  return key;
}

export function validateIdentity(
  root: string,
  state: PairedState,
  now: number,
  allowExpired = false,
): void {
  const certificate = new X509Certificate(state.certificate);
  const authority = new X509Certificate(state.authority);
  const description = describeRunnerCertificate(state.certificate);
  const key = createPrivateKey(localKey(root));
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    !certificate.publicKey.equals(createPublicKey(key)) ||
    !authority.ca ||
    !authority.verify(authority.publicKey) ||
    !certificate.checkIssued(authority) ||
    !certificate.verify(authority.publicKey) ||
    !Number.isSafeInteger(now) ||
    now < description.notBefore ||
    (!allowExpired && now >= description.notAfter) ||
    now < Date.parse(authority.validFrom) ||
    (!allowExpired && now >= Date.parse(authority.validTo))
  )
    throw new Error("Runner certificate does not match the paired identity.");
}

export function requestFingerprint(csr: string): string {
  return createHash("sha256").update(csr).digest("hex");
}
