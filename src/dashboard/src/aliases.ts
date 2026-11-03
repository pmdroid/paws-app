export const ALIAS_API_PATH = "/api/aliases";

export const ALIAS_KINDS = ["runs", "sessions", "verdicts"] as const;

export type AliasKind = (typeof ALIAS_KINDS)[number];

export interface AliasResponse {
  issueId: string;
}

export function isAliasKind(value: string | undefined): value is AliasKind {
  return (ALIAS_KINDS as readonly string[]).includes(value ?? "");
}

export function aliasApiPath(kind: AliasKind, id: string): string {
  return `${ALIAS_API_PATH}/${kind}/${encodeURIComponent(id)}`;
}

export function parseAliasResponse(
  input: unknown,
): { ok: true; response: AliasResponse } | { ok: false; error: string } {
  const issueId =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).issueId
      : undefined;
  return typeof issueId === "string" && issueId.trim() === issueId && issueId.length > 0
    ? { ok: true, response: { issueId } }
    : { ok: false, error: "aliases.issueId must be a non-empty string" };
}
