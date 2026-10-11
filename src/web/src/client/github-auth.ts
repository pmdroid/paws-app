export type GitHubSignInView = {
  user: { login: string } | null;
  device: { userCode: string; verificationUri: string } | null;
};

export function renderGitHubSignIn(state: GitHubSignInView): string {
  if (state.user) {
    return `<span class="github-user">Signed in as @${escapeHtml(state.user.login)}</span>`;
  }
  const code = state.device
    ? state.device.userCode
      ? `<p class="github-code">Enter <code>${escapeHtml(state.device.userCode)}</code> at <a href="${escapeHtml(state.device.verificationUri)}">${escapeHtml(state.device.verificationUri)}</a></p>`
      : `<p class="github-code"><a href="${escapeHtml(state.device.verificationUri)}" target="_blank" rel="noopener noreferrer">Continue with GitHub</a></p>`
    : "";
  return `<button type="button" class="btn primary" data-action="github-signin">Sign in with GitHub</button>${code}`;
}

export function readCsrfToken(root: {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}): string {
  const meta = root.querySelector('meta[name="paws-csrf"]');
  const content = meta?.getAttribute("content");
  return content ?? "";
}

export async function loadGitHubUser(
  fetchImpl: typeof fetch = fetch,
): Promise<{ login: string; id: number } | null> {
  const response = await fetchImpl("/api/auth/github", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!isRecord(body)) return null;
  const user = body.user;
  if (user === null) return null;
  if (!isRecord(user) || typeof user.login !== "string" || typeof user.id !== "number") return null;
  return { login: user.login, id: user.id };
}

export async function startGitHubDevice(
  csrf: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ userCode: string; verificationUri: string }> {
  const response = await fetchImpl("/api/auth/github/device", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-paws-csrf": csrf,
    },
  });
  if (!response.ok) throw new Error("GitHub sign-in did not start");
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.userCode !== "string" ||
    typeof body.verificationUri !== "string"
  ) {
    throw new Error("GitHub sign-in did not start");
  }
  return { userCode: body.userCode, verificationUri: body.verificationUri };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
