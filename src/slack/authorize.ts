import { journalCaught } from "../journal";
import { randomBytes } from "node:crypto";
import { requestSlackToken, SLACK_BOT_SCOPES, type SlackFetch, type SlackToken } from "./oauth";

export async function authorizeSlack(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  onAuthorize: (url: string, port: number) => void | Promise<void>;
  port?: number;
  timeoutMs?: number;
  fetch?: SlackFetch;
}): Promise<SlackToken> {
  const redirect = new URL(input.redirectUri);
  if (
    redirect.protocol !== "https:" ||
    redirect.pathname !== "/oauth/slack/callback" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw new Error("Slack requires an HTTPS /oauth/slack/callback redirect URI.");
  const state = randomBytes(32).toString("hex");
  const result = Promise.withResolvers<SlackToken>();
  const abort = new AbortController();
  let claimed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 8787,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== redirect.pathname) return reply("Not found.", 404);
      if (request.method !== "GET") return reply("Use GET for the Slack callback.", 405);
      if (url.searchParams.get("state") !== state)
        return reply("Invalid Slack authorization state.", 400);
      if (claimed) return reply("Slack authorization has already been used.", 409);
      if (url.searchParams.has("error")) {
        claimed = true;
        result.reject(new Error("Slack authorization was denied. Run paws login slack again."));
        return reply("Slack authorization was denied. Return to Paws.", 400);
      }
      const code = url.searchParams.get("code");
      if (!code) return reply("Missing Slack authorization code.", 400);
      claimed = true;
      try {
        const token = await requestSlackToken(
          input,
          new URLSearchParams({ code, redirect_uri: input.redirectUri }),
          input.fetch ?? fetch,
          abort.signal,
        );
        result.resolve(token);
        return reply("Slack authorization received. Return to Paws.", 200);
      } catch (caughtError1) {
        journalCaught(caughtError1, "authorize.fetch.requestSlackToken", null);
        result.reject(
          new Error("Could not exchange the Slack authorization code. Run paws login slack again."),
        );
        return reply("Slack authorization failed. Return to Paws.", 502);
      }
    },
  });
  const timeout = setTimeout(
    () => result.reject(new Error("Slack authorization timed out. Run paws login slack again.")),
    input.timeoutMs ?? 5 * 60_000,
  );
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    scope: SLACK_BOT_SCOPES,
    state,
    redirect_uri: input.redirectUri,
  }).toString();
  try {
    const [token] = await Promise.all([
      result.promise,
      Promise.resolve().then(() => input.onAuthorize(url.href, server.port!)),
    ]);
    return token;
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await server.stop();
  }
}

function reply(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
