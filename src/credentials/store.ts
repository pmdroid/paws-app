import type { Database } from "bun:sqlite";
import { readCredentialCiphertext, writeCredentialCiphertext, type CredentialKey } from "../db";
import { openSecret, readSecretFile, sealSecret } from "./files";

export type CredentialKind = CredentialKey["kind"];

const INSTALLATION = "installation";

export function readCredential(db: Database, secretsDir: string, kind: CredentialKind) {
  const key = { kind, workspace: INSTALLATION };
  const ciphertext = readCredentialCiphertext(db, key);
  return ciphertext === null ? null : openSecret(secretsDir, context(key), ciphertext);
}

export function writeCredential(
  db: Database,
  secretsDir: string,
  kind: CredentialKind,
  value: string,
  options: { onlyIfMissing?: boolean } = {},
): boolean {
  const key = { kind, workspace: INSTALLATION };
  return writeCredentialCiphertext(db, key, sealSecret(secretsDir, context(key), value), options);
}

export function importCredentialFile(
  db: Database,
  secretsDir: string,
  kind: CredentialKind,
  path: string,
  prepare: (value: string) => string = (value) => value,
): boolean {
  if (readCredentialCiphertext(db, { kind, workspace: INSTALLATION }) !== null) return false;
  const value = readSecretFile(path, false);
  if (value === null || value.trim().length === 0) return false;
  return writeCredential(db, secretsDir, kind, prepare(value), { onlyIfMissing: true });
}

function context(key: CredentialKey): string {
  return `credential:${key.kind}:${key.workspace}`;
}
