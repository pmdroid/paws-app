import {
  clearCredentialCiphertextSteps,
  legacyCredentialRowsSteps,
  readSecretSteps,
  replaceSecretSteps,
  secretsNamedSteps,
  type CredentialKey,
  type CredentialWrite,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { journal, journalCaught } from "../journal";
import { openSecret, readSecretFile, sealSecret } from "./files";

export type CredentialKind = CredentialKey["kind"];
export type ScopedCredential = { workspace: string; value: string } & SecretRevision;
type SecretRevision = { version: number; updatedAt: number };

const INSTALLATION = "installation";
const prefix = (kind: CredentialKind) => `oauth-${kind}-`;
const secretName = (key: CredentialKey) => prefix(key.kind) + key.workspace.replace(":", "-");

export function* readScopedCredentialSteps(
  q: Q,
  secretsDir: string,
  key: CredentialKey,
): Steps<ScopedCredential | null> {
  const name = secretName(key);
  const row = yield* readSecretSteps(q, name);
  if (row?.value == null) return null;
  const value = openSecret(secretsDir, name, row.value);
  return { workspace: key.workspace, value, version: row.version, updatedAt: row.updatedAt };
}

export function* readCredentialSteps(
  q: Q,
  secretsDir: string,
  kind: CredentialKind,
): Steps<string | null> {
  return (
    (yield* readScopedCredentialSteps(q, secretsDir, { kind, workspace: INSTALLATION }))?.value ??
    null
  );
}

export function* scopedCredentialsSteps(
  q: Q,
  secretsDir: string,
  kind: CredentialKind,
): Steps<ScopedCredential[]> {
  const rows = yield* secretsNamedSteps(q, prefix(kind));
  return rows.map((row) => {
    const scope = row.name.slice(prefix(kind).length);
    return {
      workspace: scope.startsWith("team-") ? `team:${scope.slice(5)}` : scope,
      value: openSecret(secretsDir, row.name, row.ciphertext),
      version: row.version,
      updatedAt: row.updatedAt,
    };
  });
}

export function* replaceScopedCredentialSteps(
  q: Q,
  secretsDir: string,
  key: CredentialKey,
  value: string,
  expected: number,
): Steps<number | null> {
  const name = secretName(key);
  return yield* replaceSecretSteps(q, name, sealSecret(secretsDir, name, value), expected);
}

export function* removeScopedCredentialSteps(
  q: Q,
  key: CredentialKey,
  version: number,
): Steps<boolean> {
  return (yield* replaceSecretSteps(q, secretName(key), null, version)) !== null;
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
  const current = yield* readSecretSteps(q, secretName(key));
  const expected = current?.value == null ? 0 : current.version;
  if (options.onlyIfMissing && expected !== 0) return false;
  const written = yield* replaceScopedCredentialSteps(q, secretsDir, key, value, expected);
  if (written === null && !options.onlyIfMissing)
    throw new Error(`The ${kind} grant changed while Paws saved it.`);
  return written !== null;
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
  const name = secretName({ kind, workspace: INSTALLATION });
  if ((await store.run((q) => readSecretSteps(q, name)))?.value != null) return false;
  const value = readSecretFile(path, false);
  if (value === null || value.trim().length === 0) return false;
  return writeCredential(store, secretsDir, kind, prepare(value), { onlyIfMissing: true });
}

export async function moveCredentialGrants(store: Db, secretsDir: string): Promise<number> {
  let moved = 0;
  for (const row of await store.run(legacyCredentialRowsSteps)) {
    const key = { kind: row.kind as CredentialKind, workspace: row.workspace };
    await store
      .transaction(function* (q) {
        const legacy = `credential:${key.kind}:${key.workspace}`;
        const value = openSecret(secretsDir, legacy, row.ciphertext);
        if ((yield* readScopedCredentialSteps(q, secretsDir, key)) === null) {
          const name = secretName(key);
          yield* replaceSecretSteps(q, name, sealSecret(secretsDir, name, value), 0, row.updatedAt);
          if ((yield* readScopedCredentialSteps(q, secretsDir, key))?.value !== value)
            throw new Error(`The moved ${key.kind} grant did not read back.`);
        }
        if (!(yield* clearCredentialCiphertextSteps(q, key, row.ciphertext)))
          throw new Error(`The ${key.kind} grant changed while Paws moved it.`);
      })
      .then(
        () => moved++,
        (error: unknown) => journalCaught(error, "credentials.moveCredentialGrants", null),
      );
  }
  if (moved > 0) journal(`Moved ${moved} Linear and Slack grants into the secret table.`);
  return moved;
}
