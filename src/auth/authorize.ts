import { createHash, randomBytes } from "node:crypto";
import { missingGitHubClientId, type DeviceFetch, type DeviceGrant } from "./github-device";

export const GITHUB_REDIRECT_URI = "http://127.0.0.1:3000/oauth/github/callback";

export async function authorizeGitHubApp(input: {
  clientId: string;
  clientSecret: string;
  onAuthorize: (url: string) => void | Promise<void>;
  fetch?: DeviceFetch;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DeviceGrant> {
  if (missingGitHubClientId(input.clientId) || !input.clientSecret)
    throw new Error("GitHub App client ID and client secret are required.");
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const result = Promise.withResolvers<DeviceGrant>();
  const abort = new AbortController();
  let claimed = false;
  let redirectUri = GITHUB_REDIRECT_URI;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 3000,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/oauth/github/callback") return response("Not found.", 404);
      if (request.method !== "GET") return response("Use GET for the OAuth callback.", 405);
      if (url.searchParams.get("state") !== state)
        return response("Invalid GitHub authorization state.", 400);
      if (claimed) return response("This authorization has already been used.", 409);
      if (url.searchParams.has("error")) {
        claimed = true;
        result.reject(
          new Error("GitHub authorization was denied. Run paws login github --app again."),
        );
        return response("GitHub authorization was denied. Return to Paws.", 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return response("Missing GitHub authorization code.", 400);
      claimed = true;
      try {
        const exchanged = await (input.fetch ?? fetch)(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            signal: abort.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: input.clientId,
              client_secret: input.clientSecret,
              code,
              redirect_uri: redirectUri,
              code_verifier: verifier,
            }).toString(),
          },
        );
        const body: unknown = await exchanged.json();
        if (
          !exchanged.ok ||
          !isRecord(body) ||
          body.error ||
          typeof body.access_token !== "string" ||
          !body.access_token ||
          /\s/.test(body.access_token)
        )
          throw new Error("Invalid token response");
        const expires = body.expires_in;
        if (
          expires !== undefined &&
          (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires <= 0)
        )
          throw new Error("Invalid token expiry");
        result.resolve({
          accessToken: body.access_token,
          refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
          expiresIn: typeof expires === "number" ? expires : null,
          scope: "",
        });
        return response("GitHub authorization received. Return to Paws to finish sign-in.", 200);
      } catch {
        result.reject(
          new Error(
            "Could not exchange the GitHub authorization code. Run paws login github --app again.",
          ),
        );
        return response("GitHub authorization failed. Return to Paws.", 502);
      }
    },
  });
  redirectUri = `http://127.0.0.1:${server.port}/oauth/github/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const timeout = setTimeout(
    () =>
      result.reject(
        new Error("GitHub authorization timed out. Run paws login github --app again."),
      ),
    input.timeoutMs ?? 5 * 60_000,
  );
  const cancel = () => result.reject(new Error("GitHub authorization was cancelled."));
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  try {
    const [grant] = await Promise.all([
      result.promise,
      Promise.resolve().then(() => input.onAuthorize(authorize.href)),
    ]);
    return grant;
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    clearTimeout(timeout);
    abort.abort();
    await server.stop();
  }
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
