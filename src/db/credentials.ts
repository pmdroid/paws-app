import { and, eq, like, ne, sql } from "drizzle-orm";
import { type Q } from "./db";

export type CredentialKey = { kind: "linear" | "slack"; workspace: string };

export type CredentialWrite = { onlyIfMissing?: boolean };

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
      .select({
        ciphertext: secret.ciphertext,
        version: secret.version,
        updatedAt: secret.updatedAt,
      })
      .from(secret)
      .where(eq(secret.name, name)),
  );
  if (!row) return null;
  const value = row.ciphertext === "" ? null : row.ciphertext;
  return { value, version: row.version, updatedAt: row.updatedAt };
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

export function* secretsNamedSteps(q: Q, prefix: string) {
  const { secret } = q.t;
  return yield* q.all(
    q.orm
      .select()
      .from(secret)
      .where(and(like(secret.name, `${prefix}%`), ne(secret.ciphertext, ""))),
  );
}

export function* replaceSecretSteps(
  q: Q,
  name: string,
  ciphertext: string | null,
  expected: number,
  now = Date.now(),
) {
  const { secret } = q.t;
  if (ciphertext === null && expected === 0) return null;
  const set = { ciphertext: ciphertext ?? "", updatedAt: now, version: sql`${secret.version} + 1` };
  const rows = yield* q.all(
    expected === 0
      ? q.orm
          .insert(secret)
          .values({ name, ciphertext: ciphertext!, updatedAt: now })
          .onConflictDoUpdate({ target: secret.name, set, setWhere: eq(secret.ciphertext, "") })
          .returning({ version: secret.version })
      : q.orm
          .update(secret)
          .set(set)
          .where(
            and(eq(secret.name, name), eq(secret.version, expected), ne(secret.ciphertext, "")),
          )
          .returning({ version: secret.version }),
  );
  return rows[0]?.version ?? null;
}

export function* legacyCredentialRowsSteps(q: Q, kind?: CredentialKey["kind"]) {
  const { credential } = q.t;
  const live = ne(credential.ciphertext, "");
  return yield* q.all(
    q.orm
      .select()
      .from(credential)
      .where(kind === undefined ? live : and(live, eq(credential.kind, kind))),
  );
}

export function* clearCredentialCiphertextSteps(q: Q, key: CredentialKey, ciphertext?: string) {
  const { credential } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(credential)
      .set({ ciphertext: "" })
      .where(
        and(
          eq(credential.kind, key.kind),
          eq(credential.workspace, key.workspace),
          ciphertext === undefined
            ? ne(credential.ciphertext, "")
            : eq(credential.ciphertext, ciphertext),
        ),
      )
      .returning({ kind: credential.kind }),
  );
  return rows.length > 0;
}
