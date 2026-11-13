import {
  agentCredentialCiphertextSteps,
  writeAgentCredentialCiphertextSteps,
  type AgentCredentialWrite,
  type Q,
  type Steps,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import { openSecret, sealSecret } from "./files";

export type AgentCredential = {
  agent: RunnerCodingAgent;
  blob: string;
  version: number;
  updatedAt: number;
  runnerId: string | null;
};

export function* readAgentCredentialSteps(
  q: Q,
  secretsDir: string,
  accountId: string,
): Steps<AgentCredential | null> {
  const stored = yield* agentCredentialCiphertextSteps(q, accountId);
  if (!stored) return null;
  const { ciphertext, ...rest } = stored;
  return { ...rest, blob: openSecret(secretsDir, context(accountId), ciphertext) };
}

export function* writeAgentCredentialSteps(
  q: Q,
  secretsDir: string,
  input: { accountId: string; runnerId: string; version: number; blob: string; now: number },
): Steps<AgentCredentialWrite> {
  const { blob, ...write } = input;
  return yield* writeAgentCredentialCiphertextSteps(q, {
    ...write,
    ciphertext: sealSecret(secretsDir, context(input.accountId), blob),
  });
}

function context(accountId: string): string {
  return `agent-account-credential:${accountId}`;
}
