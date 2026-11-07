import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { orm } from "./orm";
import { credential } from "./schema";

export type CredentialKey = { kind: "linear" | "slack"; workspace: string };

export function readCredentialCiphertext(db: Database, key: CredentialKey): string | null {
  return (
    orm(db)
      .select({ ciphertext: credential.ciphertext })
      .from(credential)
      .where(and(eq(credential.kind, key.kind), eq(credential.workspace, key.workspace)))
      .get()?.ciphertext ?? null
  );
}

export function writeCredentialCiphertext(
  db: Database,
  key: CredentialKey,
  ciphertext: string,
  options: { now?: number; onlyIfMissing?: boolean } = {},
): boolean {
  const updatedAt = options.now ?? Date.now();
  const insert = orm(db)
    .insert(credential)
    .values({ kind: key.kind, workspace: key.workspace, ciphertext, updatedAt });
  const written = options.onlyIfMissing
    ? insert.onConflictDoNothing()
    : insert.onConflictDoUpdate({
        target: [credential.kind, credential.workspace],
        set: { ciphertext, updatedAt },
      });
  return written.returning({ kind: credential.kind }).all().length > 0;
}
