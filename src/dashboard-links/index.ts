export const DASHBOARD_PATH = "/dashboard";

export const LEGACY_DASHBOARD_PATH = "/status";

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function isDashboardPath(pathname: string): boolean {
  return under(pathname, DASHBOARD_PATH);
}

export function isLegacyDashboardPath(pathname: string): boolean {
  return under(pathname, LEGACY_DASHBOARD_PATH);
}

export function isDashboardPage(pathname: string): boolean {
  return pathname === "/" || isDashboardPath(pathname) || isLegacyDashboardPath(pathname);
}

const MOVED_PAGES: Record<string, string> = { "/settings/findings": "/findings" };

export function legacyDashboardLocation(pathname: string, search = ""): string | null {
  const base = isLegacyDashboardPath(pathname)
    ? LEGACY_DASHBOARD_PATH
    : isDashboardPath(pathname)
      ? DASHBOARD_PATH
      : null;
  if (base === null) return null;
  const rest = pathname.slice(base.length).replace(/^\/+/, "/");
  const moved = MOVED_PAGES[rest.replace(/\/$/, "")];
  if (base === DASHBOARD_PATH && moved === undefined) return null;
  return `${DASHBOARD_PATH}${moved ?? (rest || "/")}${search}`;
}

export function dashboardPath(page = "/"): string {
  return `${DASHBOARD_PATH}${page.startsWith("/") ? page : `/${page}`}`;
}

export function dashboardUrl(origin: string, page = "/"): string {
  return `${origin.replace(/\/+$/, "")}${dashboardPath(page)}`;
}

export function dashboardIssuePath(identifier: string): string {
  return dashboardPath(`/issues/${encodeURIComponent(identifier)}`);
}
