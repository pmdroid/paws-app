import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  authorizeSlack,
  createSlackAuth,
  handleSlackWebhook,
  loginSlack,
  readSlackApp,
  readSlackToken,
  SLACK_BOT_SCOPES,
} from "../src/slack";
import { writeSecretFile } from "../src/credentials";
import { startServer } from "../src/server";
import { listJobs } from "../src/db";
import { tempDb, tempHome } from "./helpers";

const homes: string[] = [];
afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function home(): string {
  const value = tempHome();
  homes.push(value);
  return value;
}
const env = {
  PAWS_PUBLIC_URL: "https://paws.example",
  SLACK_CLIENT_ID: "synthetic-slack-client",
  SLACK_CLIENT_SECRET: "synthetic-slack-secret",
  SLACK_SIGNING_SECRET: "synthetic-signing-secret",
};
const grant = {
  ok: true,
  token_type: "bot",
  access_token: "synthetic-slack-token",
  scope: SLACK_BOT_SCOPES,
  team: { id: "T1" },
  bot_user_id: "U1",
};

async function approve(link: string, port: number): Promise<void> {
  const url = new URL(link);
  const callback = new URL(`http://127.0.0.1:${port}/oauth/slack/callback`);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-code");
  expect((await fetch(callback)).status).toBe(200);
}

test("Slack OAuth uses bot scopes, exact HTTPS redirect and single-use state, then encrypts its installation", async () => {
  const dir = home();
  let exchanges = 0;
  let port = 0;
  const token = await loginSlack({
    home: dir,
    env,
    port: 0,
    timeoutMs: 2_000,
    fetch: async (url, init) => {
      expect(url).toBe("https://slack.com/api/oauth.v2.access");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from(`${env.SLACK_CLIENT_ID}:${env.SLACK_CLIENT_SECRET}`).toString("base64")}`,
      );
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        code: "synthetic-code",
        redirect_uri: "https://paws.example/oauth/slack/callback",
      });
      exchanges += 1;
      return Response.json(grant);
    },
    async onAuthorize(link, callbackPort) {
      port = callbackPort;
      const url = new URL(link);
      expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
      expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES);
      expect(url.searchParams.has("user_scope")).toBe(false);
      const callback = new URL(`http://127.0.0.1:${port}/oauth/slack/callback`);
      expect((await fetch(callback, { method: "POST" })).status).toBe(405);
      callback.searchParams.set("state", "wrong");
      callback.searchParams.set("code", "synthetic-code");
      expect((await fetch(callback)).status).toBe(400);
      expect(exchanges).toBe(0);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(grant.access_token);
      expect((await fetch(callback)).status).toBe(409);
    },
  });
  expect(exchanges).toBe(1);
  expect(token).toMatchObject({
    accessToken: grant.access_token,
    teamId: "T1",
    botUserId: "U1",
    refreshToken: null,
  });
  expect(readSlackToken(dir)).toEqual(token);
  expect(readSlackApp(dir)).toEqual({
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    signingSecret: env.SLACK_SIGNING_SECRET,
  });
  for (const file of ["slack-app.json", "slack-oauth.json"]) {
    const bytes = readFileSync(join(dir, "secrets", file), "utf8");
    for (const secret of [grant.access_token, env.SLACK_CLIENT_SECRET, env.SLACK_SIGNING_SECRET])
      expect(bytes).not.toContain(secret);
  }
  await expect(fetch(`http://127.0.0.1:${port}/oauth/slack/callback`)).rejects.toThrow();
});

test("Slack rejects denial and provider errors without saving or reflecting credentials", async () => {
  for (const mode of ["deny", "error", "scopes"]) {
    const dir = home();
    await expect(
      loginSlack({
        home: dir,
        env,
        port: 0,
        timeoutMs: 1_000,
        fetch: async () =>
          mode === "scopes"
            ? Response.json({ ...grant, scope: "chat:write" })
            : Response.json({ ok: false, error: env.SLACK_CLIENT_SECRET }),
        async onAuthorize(link, port) {
          const url = new URL(`http://127.0.0.1:${port}/oauth/slack/callback`);
          url.searchParams.set("state", new URL(link).searchParams.get("state")!);
          url.searchParams.set(
            mode === "deny" ? "error" : "code",
            mode === "deny" ? "access_denied" : "synthetic-code",
          );
          url.searchParams.set("error_description", env.SLACK_CLIENT_SECRET);
          const response = await fetch(url);
          expect(response.status).toBe(mode === "deny" ? 400 : 502);
          expect(await response.text()).not.toContain(env.SLACK_CLIENT_SECRET);
        },
      }),
    ).rejects.toThrow(mode === "deny" ? "Slack authorization was denied" : "Could not exchange");
    expect(readSlackToken(dir)).toBeNull();
    expect(readSlackApp(dir)).toBeNull();
  }
});

test("Slack OAuth requires HTTPS and aborts an outstanding exchange on timeout", async () => {
  await expect(
    authorizeSlack({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      redirectUri: "http://localhost/oauth/slack/callback",
      onAuthorize() {},
    }),
  ).rejects.toThrow("HTTPS");
  let port = 0;
  let signal: AbortSignal | undefined;
  await expect(
    loginSlack({
      home: home(),
      env,
      port: 0,
      timeoutMs: 100,
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        await new Promise((_, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
        throw new Error("unreachable");
      },
      async onAuthorize(link, value) {
        port = value;
        await approve(link, value).catch(() => {});
      },
    }),
  ).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  await expect(fetch(`http://127.0.0.1:${port}/oauth/slack/callback`)).rejects.toThrow();
});

test("rotating Slack bot tokens use one durable refresh job and retain installation identity", async () => {
  const dir = home();
  const token = await loginSlack({
    home: dir,
    env,
    port: 0,
    fetch: async () =>
      Response.json({ ...grant, refresh_token: "synthetic-slack-refresh-old", expires_in: 3600 }),
    onAuthorize: approve,
  });
  writeSecretFile(
    join(dir, "secrets", "slack-oauth.json"),
    JSON.stringify({ ...token, expiresAtMs: 0 }),
  );
  const db = tempDb();
  let requests = 0;
  const options = {
    home: dir,
    db,
    fetch: async (_url: string, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(
        "synthetic-slack-refresh-old",
      );
      requests += 1;
      await Bun.sleep(75);
      return Response.json({
        ok: true,
        token_type: "bot",
        access_token: "synthetic-slack-token-next",
        refresh_token: "synthetic-slack-refresh-next",
        expires_in: 43200,
      });
    },
  };
  try {
    expect(
      await Promise.all([
        createSlackAuth(options).ensureFresh(),
        createSlackAuth(options).ensureFresh(),
      ]),
    ).toEqual(["synthetic-slack-token-next", "synthetic-slack-token-next"]);
    expect(requests).toBe(1);
    expect(readSlackToken(dir)).toMatchObject({
      teamId: "T1",
      botUserId: "U1",
      scope: SLACK_BOT_SCOPES,
      refreshToken: "synthetic-slack-refresh-next",
    });
    expect(listJobs(db).map((job) => job.status)).toEqual(["done"]);
  } finally {
    db.close();
  }
});

test("Slack front door verifies raw-body HMAC and a five-minute timestamp window before returning its challenge", async () => {
  const secret = "synthetic-signing-secret";
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    webhooks: false,
    slackSigningSecret: secret,
  });
  const endpoint = `http://127.0.0.1:${server.port}/webhooks/slack`;
  const raw = JSON.stringify({ type: "url_verification", challenge: "challenge-京都" });
  const timestamp = Math.floor(Date.now() / 1000);
  function headers(time: number, value = raw) {
    return {
      "x-slack-request-timestamp": String(time),
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${time}:${value}`).digest("hex")}`,
    };
  }
  try {
    expect((await fetch(endpoint, { method: "POST", body: raw })).status).toBe(401);
    expect(
      (await fetch(endpoint, { method: "POST", body: raw + " ", headers: headers(timestamp) }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(endpoint, { method: "POST", body: raw, headers: headers(timestamp - 301) }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(endpoint, { method: "POST", body: raw, headers: headers(timestamp + 600) }))
        .status,
    ).toBe(401);
    const response = await fetch(endpoint, {
      method: "POST",
      body: raw,
      headers: headers(timestamp),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-京都" });
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          body: "invalid",
          headers: headers(timestamp, "invalid"),
        })
      ).status,
    ).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("Slack webhook enforces exact past and future timestamp boundaries with a fixed clock", async () => {
  const secret = "synthetic-signing-secret";
  const timestamp = 1_000_000;
  const raw = JSON.stringify({ type: "url_verification", challenge: "clock-boundary" });
  for (const offset of [-301, -300, -299, 0, 299, 300, 301]) {
    const time = timestamp + offset;
    const response = await handleSlackWebhook(
      new Request("https://paws.example/webhooks/slack", {
        method: "POST",
        body: raw,
        headers: {
          "x-slack-request-timestamp": String(time),
          "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${time}:${raw}`).digest("hex")}`,
        },
      }),
      secret,
      timestamp * 1000,
    );
    expect(response.status).toBe(Math.abs(offset) <= 300 ? 200 : 401);
  }
});
