export function githubUrl(value: string, kind: "install" | "authorize"): string {
  const url = new URL(value);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    (kind === "authorize"
      ? url.pathname !== "/login/oauth/authorize"
      : !/^\/apps\/[a-z0-9-]+\/installations\/new$/.test(url.pathname))
  )
    throw new Error("GitHub returned an invalid connection link. Refresh status to try again.");
  return url.href;
}
