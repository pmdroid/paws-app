import {
  agentCredentialCiphertextSteps,
  agentCredentialSecretName,
  clearLegacyAgentCredentialSteps,
  legacyAgentCredentialsSteps,
  putAgentCredentialSecretSteps,
  writeAgentCredentialCiphertextSteps,
  type AgentCredentialCiphertext,
  type AgentCredentialWrite,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { journal, journalCaught } from "../journal";
import { openSecret, sealSecret } from "./files";

export type AgentCredential = Omit<AgentCredentialCiphertext, "ciphertext"> & {
  blob: string | null;
};

export function* readAgentCredentialSteps(
  q: Q,
  secretsDir: string,
  accountId: string,
): Steps<AgentCredential | null> {
  const stored = yield* agentCredentialCiphertextSteps(q, accountId);
  if (!stored) return null;
  const { ciphertext, ...rest } = stored;
  return {
    ...rest,
    blob:
      ciphertext === ""
        ? null
        : openSecret(secretsDir, agentCredentialSecretName(accountId), ciphertext),
  };
}

export function* writeAgentCredentialSteps(
  q: Q,
  secretsDir: string,
  input: { accountId: string; runnerId: string | null; version: number; blob: string; now: number },
): Steps<AgentCredentialWrite> {
  const { blob, ...write } = input;
  return yield* writeAgentCredentialCiphertextSteps(q, {
    ...write,
    ciphertext: sealSecret(secretsDir, agentCredentialSecretName(input.accountId), blob),
  });
}

export async function migrateAgentCredentials(store: Db, secretsDir: string): Promise<number> {
  let moved = 0;
  for (const row of await store.run(legacyAgentCredentialsSteps)) {
    const name = agentCredentialSecretName(row.accountId);
    try {
      await store.transaction(function* (q) {
        const blob = openSecret(
          secretsDir,
          `agent-account-credential:${row.accountId}`,
          row.ciphertext,
        );
        const sealed = sealSecret(secretsDir, name, blob);
        yield* putAgentCredentialSecretSteps(q, row.accountId, sealed, Date.now());
        const stored = yield* agentCredentialCiphertextSteps(q, row.accountId);
        if (stored?.ciphertext !== sealed || openSecret(secretsDir, name, sealed) !== blob)
          throw new Error("The moved agent account credential did not verify.");
        if (!(yield* clearLegacyAgentCredentialSteps(q, row.accountId, row.ciphertext)))
          throw new Error("The agent account credential changed while it was moved.");
      });
      moved += 1;
    } catch (error) {
      journalCaught(error, "credentials.migrateAgentCredentials", null);
    }
  }
  if (moved > 0)
    journal(`Moved ${moved} agent account ${moved === 1 ? "sign-in" : "sign-ins"} into secrets.`);
  return moved;
}
