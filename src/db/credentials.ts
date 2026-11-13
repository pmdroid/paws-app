import { and, eq, ne } from "drizzle-orm";
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

export function* writeSecretRowSteps(
  q: Q,
  input: { name: string; ciphertext: string | null; now: number; exclusive: boolean },
) {
  const { secret } = q.t;
  const { name, now } = input;
  const ciphertext = input.ciphertext ?? "";
  const rows = yield* q.all(
    q.orm
      .insert(secret)
      .values({ name, ciphertext, updatedAt: now })
      .onConflictDoUpdate({
        target: secret.name,
        set: { ciphertext, updatedAt: now },
        ...(input.exclusive ? { setWhere: eq(secret.ciphertext, "") } : {}),
      })
      .returning({ name: secret.name }),
  );
  return rows.length > 0;
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
