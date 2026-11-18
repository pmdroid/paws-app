import {
  deleteCredentialCiphertextSteps,
  readCredentialCiphertextSteps,
  writeCredentialCiphertextSteps,
  type CredentialKey,
  type CredentialWrite,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { openSecret, readSecretFile, sealSecret } from "./files";

export type CredentialKind = CredentialKey["kind"];

const INSTALLATION = "installation";

export function* readCredentialSteps(
  q: Q,
  secretsDir: string,
  kind: CredentialKind,
): Steps<string | null> {
  return yield* readScopedCredentialSteps(q, secretsDir, { kind, workspace: INSTALLATION });
}

export function* readScopedCredentialSteps(
  q: Q,
  secretsDir: string,
  key: CredentialKey,
): Steps<string | null> {
  const ciphertext = yield* readCredentialCiphertextSteps(q, key);
  return ciphertext === null ? null : openSecret(secretsDir, context(key), ciphertext);
}

export function* writeScopedCredentialSteps(
  q: Q,
  secretsDir: string,
  key: CredentialKey,
  value: string,
): Steps<boolean> {
  return yield* writeCredentialCiphertextSteps(q, key, sealSecret(secretsDir, context(key), value));
}

export function* deleteScopedCredentialSteps(q: Q, key: CredentialKey): Steps<void> {
  yield* deleteCredentialCiphertextSteps(q, key);
}

export function readCredential(
  store: Db,
  secretsDir: string,
  kind: CredentialKind,
): Promise<string | null> {
  return store.run((q) => readCredentialSteps(q, secretsDir, kind));
}

export function* writeCredentialSteps(
  q: Q,
  secretsDir: string,
  kind: CredentialKind,
  value: string,
  options: CredentialWrite = {},
): Steps<boolean> {
  const key = { kind, workspace: INSTALLATION };
  return yield* writeCredentialCiphertextSteps(
    q,
    key,
    sealSecret(secretsDir, context(key), value),
    options,
  );
}

export function writeCredential(
  store: Db,
  secretsDir: string,
  kind: CredentialKind,
  value: string,
  options: CredentialWrite = {},
): Promise<boolean> {
  return store.run((q) => writeCredentialSteps(q, secretsDir, kind, value, options));
}

export async function importCredentialFile(
  store: Db,
  secretsDir: string,
  kind: CredentialKind,
  path: string,
  prepare: (value: string) => string = (value) => value,
): Promise<boolean> {
  const key = { kind, workspace: INSTALLATION };
  if ((await store.run((q) => readCredentialCiphertextSteps(q, key))) !== null) return false;
  const value = readSecretFile(path, false);
  if (value === null || value.trim().length === 0) return false;
  return writeCredential(store, secretsDir, kind, prepare(value), { onlyIfMissing: true });
}

function context(key: CredentialKey): string {
  return `credential:${key.kind}:${key.workspace}`;
}
