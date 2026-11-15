export const DASHBOARD_PATH = "/dashboard";

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function isDashboardPath(pathname: string): boolean {
  return under(pathname, DASHBOARD_PATH);
}

export function isDashboardPage(pathname: string): boolean {
  return pathname === "/" || isDashboardPath(pathname);
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
