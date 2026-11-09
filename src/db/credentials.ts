import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

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

export function readCredentialCiphertext(db: Database, key: CredentialKey): string | null {
  return settled(sqliteDb(db).run((q) => readCredentialCiphertextSteps(q, key)));
}

type CredentialWrite = { now?: number; onlyIfMissing?: boolean };

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

export function writeCredentialCiphertext(
  db: Database,
  key: CredentialKey,
  ciphertext: string,
  options: CredentialWrite = {},
): boolean {
  return settled(
    sqliteDb(db).run((q) => writeCredentialCiphertextSteps(q, key, ciphertext, options)),
  );
}
