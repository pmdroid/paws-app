import { and, eq, ne, sql } from "drizzle-orm";
import { type Q } from "./db";

export type CredentialKey = { kind: "linear" | "slack"; workspace: string };

export function* readCredentialCiphertextSteps(q: Q, key: CredentialKey) {
  const { credential } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ ciphertext: credential.ciphertext })
      .from(credential)
      .where(and(eq(credential.kind, key.kind), eq(credential.workspace, key.workspace))),
  );
  return row?.ciphertext ?? null;
}

export type CredentialWrite = { now?: number; onlyIfMissing?: boolean };

export function* writeCredentialCiphertextSteps(
  q: Q,
  key: CredentialKey,
  ciphertext: string,
  options: CredentialWrite = {},
) {
  const { credential } = q.t;
  const updatedAt = options.now ?? Date.now();
  const insert = q.orm
    .insert(credential)
    .values({ kind: key.kind, workspace: key.workspace, ciphertext, updatedAt });
  const written = options.onlyIfMissing
    ? insert.onConflictDoNothing()
    : insert.onConflictDoUpdate({
        target: [credential.kind, credential.workspace],
        set: { ciphertext, updatedAt },
      });
  const rows = yield* q.all(written.returning({ kind: credential.kind }));
  return rows.length > 0;
}

export type SecretRow = { name: string; ciphertext: string };

export function* secretRowsSteps(q: Q) {
  const { secret } = q.t;
  return yield* q.all(
    q.orm
      .select({ name: secret.name, ciphertext: secret.ciphertext })
      .from(secret)
      .where(ne(secret.ciphertext, "")),
  );
}

export type SecretVersion = { name: string; version: number };

export class SecretConflictError extends Error {
  constructor(
    readonly secret: string,
    readonly expectedVersion: number | null,
  ) {
    super(`Secret ${secret} changed since version ${expectedVersion ?? "none"}.`);
    this.name = "SecretConflictError";
  }
}

export function* secretVersionsSteps(q: Q) {
  const { secret } = q.t;
  return yield* q.all(q.orm.select({ name: secret.name, version: secret.version }).from(secret));
}

export function* readSecretSteps(q: Q, name: string) {
  const { secret } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ ciphertext: secret.ciphertext, version: secret.version })
      .from(secret)
      .where(eq(secret.name, name)),
  );
  if (!row) return null;
  return { value: row.ciphertext === "" ? null : row.ciphertext, version: row.version };
}

export function* writeSecretSteps(
  q: Q,
  name: string,
  value: string | null,
  expectedVersion: number | null,
  now = Date.now(),
) {
  const { secret } = q.t;
  const ciphertext = value ?? "";
  const rows = yield* q.all(
    expectedVersion === null
      ? q.orm
          .insert(secret)
          .values({ name, ciphertext, updatedAt: now })
          .onConflictDoNothing()
          .returning({ version: secret.version })
      : q.orm
          .update(secret)
          .set({ ciphertext, updatedAt: now, version: sql`${secret.version} + 1` })
          .where(and(eq(secret.name, name), eq(secret.version, expectedVersion)))
          .returning({ version: secret.version }),
  );
  const written = rows[0];
  if (written === undefined) throw new SecretConflictError(name, expectedVersion);
  return written.version;
}

export function* copySecretRowsSteps(q: Q, rows: readonly SecretRow[], now: number) {
  const { secret } = q.t;
  if (rows.length === 0) return 0;
  const copied = yield* q.all(
    q.orm
      .insert(secret)
      .values(rows.map((row) => ({ ...row, updatedAt: now })))
      .onConflictDoNothing()
      .returning({ name: secret.name }),
  );
  return copied.length;
}

export function* credentialRowsSteps(q: Q, kind: CredentialKey["kind"]) {
  const { credential } = q.t;
  return yield* q.all(q.orm.select().from(credential).where(eq(credential.kind, kind)));
}

export function* replaceCredentialCiphertextSteps(
  q: Q,
  key: CredentialKey,
  ciphertext: string,
  expected: number,
) {
  const { credential } = q.t;
  const updatedAt = Math.max(Date.now(), expected + 1);
  const rows = yield* q.all(
    expected === 0
      ? q.orm
          .insert(credential)
          .values({ ...key, ciphertext, updatedAt })
          .onConflictDoNothing()
          .returning({ updatedAt: credential.updatedAt })
      : q.orm
          .update(credential)
          .set({ ciphertext, updatedAt })
          .where(and(match(q, key), eq(credential.updatedAt, expected)))
          .returning({ updatedAt: credential.updatedAt }),
  );
  return rows[0]?.updatedAt ?? null;
}

export function* deleteCredentialCiphertextSteps(q: Q, key: CredentialKey, expected: number) {
  const { credential } = q.t;
  const rows = yield* q.all(
    q.orm
      .delete(credential)
      .where(and(match(q, key), eq(credential.updatedAt, expected)))
      .returning({ kind: credential.kind }),
  );
  return rows.length > 0;
}

function match(q: Q, key: CredentialKey) {
  const { credential } = q.t;
  return and(eq(credential.kind, key.kind), eq(credential.workspace, key.workspace));
}
