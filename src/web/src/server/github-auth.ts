import { timingSafeEqual } from "node:crypto";

export type GitHubSignInUser = { login: string; id: number };

export type GitHubSignIn = {
  user(): Promise<GitHubSignInUser | null>;
  beginDevice(): Promise<{
    userCode: string;
    verificationUri: string;
    completed: Promise<GitHubSignInUser>;
  }>;
};

const AUTH_PATH = "/api/auth/github";
const DEVICE_PATH = "/api/auth/github/device";

let processToken: string | null = null;

/** One CSRF token for this process. The status page embeds it. */
export function processCsrfToken(): string {
  processToken ??= crypto.randomUUID();
  return processToken;
}

export function injectCsrf(html: string, token: string = processCsrfToken()): string {
  if (html.includes('name="paws-csrf"')) return html;
  const meta = `<meta name="paws-csrf" content="${token}" />`;
  if (html.includes("<head>")) return html.replace("<head>", `<head>\n    ${meta}`);
  return `${meta}\n${html}`;
}

export async function handleGitHubAuthRequest(
  request: Request,
  githubAuth: GitHubSignIn | undefined,
  csrfToken: string = processCsrfToken(),
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== AUTH_PATH && url.pathname !== DEVICE_PATH) return null;
  if (!loopbackRequest(request)) return json({ error: "GitHub sign-in is loopback only" }, 403);
  if (request.method === "GET" && url.pathname === AUTH_PATH) {
    const user = githubAuth ? await githubAuth.user() : null;
    return json({ user }, 200);
  }
  if (request.method === "POST" && url.pathname === DEVICE_PATH) {
    if (!sameToken(request.headers.get("x-paws-csrf"), csrfToken)) {
      return json({ error: "CSRF token missing" }, 403);
    }
    if (!githubAuth) return json({ error: "Run `bun run paws login github`" }, 503);
    const started = await githubAuth.beginDevice();
    void started.completed.catch(() => undefined);
    return json({ userCode: started.userCode, verificationUri: started.verificationUri }, 200);
  }
  return json({ error: "Method not allowed" }, 405);
}

function loopbackRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (!isLoopbackHost(url.hostname)) return false;
  const host = request.headers.get("host");
  if (host !== null && !isLoopbackHost(hostHeaderName(host))) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    try {
      if (!isLoopbackHost(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function hostHeaderName(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) return value;
  return value.slice(0, colon);
}

export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function sameToken(header: string | null, expected: string): boolean {
  if (header === null) return false;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
