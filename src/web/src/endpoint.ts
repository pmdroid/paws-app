const HTTP = new Set(["http:", "https:"]);

export function parseEngineUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!HTTP.has(url.protocol) || url.username || url.password) return null;
  return url.toString();
}

/** API URL for an engine origin, or for a URL that already points at `/api/status`. */
export function statusEndpoint(engineUrl: string): string {
  const parsed = parseEngineUrl(engineUrl);
  if (!parsed) throw new Error("Engine URL must be an http or https URL");
  const url = new URL(parsed);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api/status") ? path : "/api/status";
  url.search = "";
  url.hash = "";
  return url.toString();
}
