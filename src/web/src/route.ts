const VIEWS = ["issues", "runs", "sessions", "questions", "runners", "projects"] as const;
const SETTINGS = ["decisions", "agents", "integrations", "workspace", "account", "audit"] as const;

export function dashboardHash(pathname: string): string | null {
  const parts = pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter((part) => part.length > 0);
  if (parts[0] !== "status" || parts.length < 2 || parts.length > 3) return null;
  const view = decode(parts[1] ?? "");
  const id = parts[2] === undefined ? null : decode(parts[2]);
  if (view === "settings") {
    if (id !== null && !SETTINGS.some((page) => page === id)) return null;
    return id ? `#/settings/${id}` : "#/settings";
  }
  if (!VIEWS.some((entry) => entry === view)) return null;
  if (view === "runners" || view === "projects") return id === null ? `#/${view}` : null;
  return id ? `#/${view}/${encodeURIComponent(id)}` : `#/${view}`;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
