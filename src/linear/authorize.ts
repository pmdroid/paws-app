import { journalCaught } from "../journal";
import { createHash, randomBytes } from "node:crypto";
import {
  exchangeLinearCode,
  linearAuthorizeUrl,
  type FetchLike,
  type StoredLinearToken,
} from "./oauth";

export const LINEAR_REDIRECT_URI = "http://localhost:3000/oauth/callback";

export async function authorizeLinear(input: {
  clientId: string;
  clientSecret: string;
  onAuthorize: (url: string) => void | Promise<void>;
  fetch?: FetchLike;
  port?: number;
  timeoutMs?: number;
}): Promise<StoredLinearToken> {
  const state = randomBytes(32).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const result = Promise.withResolvers<StoredLinearToken>();
  const abort = new AbortController();
  const fetchToken = input.fetch ?? fetch;
  let claimed = false;
  let redirectUri = LINEAR_REDIRECT_URI;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 3000,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/oauth/callback") return response("Not found.", 404);
      if (request.method !== "GET") return response("Use GET for the OAuth callback.", 405);
      if (url.searchParams.get("state") !== state) {
        return response("Invalid Linear authorization state. Return to Paws.", 400);
      }
      if (claimed) return response("This Linear authorization has already been used.", 409);
      if (url.searchParams.has("error")) {
        claimed = true;
        result.reject(new Error("Linear authorization was denied. Retry Linear authorization."));
        return response("Linear authorization was denied. Return to Paws.", 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return response("Missing Linear authorization code. Return to Paws.", 400);
      claimed = true;
      try {
        const token = await exchangeLinearCode({
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          code,
          codeVerifier,
          redirectUri,
          fetch: (tokenUrl, init) => fetchToken(tokenUrl, { ...init, signal: abort.signal }),
        });
        result.resolve(token);
        return response("Linear authorization received. Return to Paws.", 200);
      } catch (caughtError1) {
        journalCaught(caughtError1, "authorize.fetch.exchangeLinearCode", null);
        result.reject(
          new Error(
            "Could not exchange the Linear authorization code. Retry Linear authorization.",
          ),
        );
        return response("Linear authorization failed. Return to Paws.", 502);
      }
    },
  });
  redirectUri = `http://localhost:${server.port}/oauth/callback`;
  const timeout = setTimeout(
    () => {
      result.reject(new Error("Linear authorization timed out. Retry Linear authorization."));
    },
    input.timeoutMs ?? 5 * 60_000,
  );
  try {
    const [token] = await Promise.all([
      result.promise,
      Promise.resolve().then(() =>
        input.onAuthorize(
          linearAuthorizeUrl({ clientId: input.clientId, redirectUri, state, codeChallenge }),
        ),
      ),
    ]);
    return token;
  } finally {
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
