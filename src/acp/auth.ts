import type { AuthMethod, InitializeResponse } from "@agentclientprotocol/sdk";

export interface AuthMethodSummary {
  id: string;
  name: string;
  type: "terminal" | "agent";
}

export interface AuthCheckResult {
  protocolVersion: number;
  agentName?: string;
  authMethods: AuthMethodSummary[];
  /** Paws never sends `authenticate`. */
  authenticateCalled: false;
  /** Credential files and keychains are not read to perform this check. */
  credentialsRead: false;
  protocolAuthAdvertised: boolean;
  terminalAuthAdvertised: boolean;
}

export function summarizeAuth(response: InitializeResponse): AuthCheckResult {
  const authMethods = (response.authMethods ?? []).map(summarizeMethod);
  return {
    protocolVersion: response.protocolVersion,
    ...(response.agentInfo?.name ? { agentName: response.agentInfo.name } : {}),
    authMethods,
    authenticateCalled: false,
    credentialsRead: false,
    protocolAuthAdvertised: authMethods.some((method) => method.type === "agent"),
    terminalAuthAdvertised: authMethods.some((method) => method.type === "terminal"),
  };
}

function summarizeMethod(method: AuthMethod): AuthMethodSummary {
  const type = "type" in method && method.type === "terminal" ? "terminal" : "agent";
  return { id: method.id, name: method.name, type };
}

export function isAuthRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  if (code === -32000) return true;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /auth_required|authentication required/i.test(message);
}

export const AUTH_REQUIRED_MESSAGE =
  "The agent requires authentication. Paws does not call authenticate and does not read credential files. Log in with Claude Code or Codex on this machine, then retry.";
