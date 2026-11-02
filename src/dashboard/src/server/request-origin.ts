export function dashboardOrigin(request: Request, trustedOrigin?: string): boolean {
  const url = new URL(request.url);
  if (
    trustedOrigin === undefined
      ? !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      : url.origin !== trustedOrigin
  )
    return false;
  if (
    request.headers.has("host") &&
    request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase()
  )
    return false;
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) return false;
  return request.headers.get("sec-fetch-site") !== "cross-site";
}
