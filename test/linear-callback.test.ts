import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { authorizeLinear, LINEAR_APP_SCOPES, type FetchLike } from "../src/linear";

test("Linear callback rejects unrelated requests and exchanges a valid code once", async () => {
  let exchanges = 0;
  let redirectUri = "";
  let challenge = "";
  const started = Date.now();
  const token = await authorizeLinear({
    clientId: "client-1",
    clientSecret: "fake-client-secret",
    port: 0,
    timeoutMs: 2_000,
    fetch: async (input, init) => {
      exchanges += 1;
      expect(String(input)).toBe("https://api.linear.app/oauth/token");
      const body = new URLSearchParams(String(init?.body));
      const verifier = body.get("code_verifier")!;
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
      expect(Object.fromEntries(body)).toEqual({
        code_verifier: verifier,
        grant_type: "authorization_code",
        code: "fake-code",
        redirect_uri: redirectUri,
        client_id: "client-1",
        client_secret: "fake-client-secret",
      });
      return Response.json({
        access_token: "fake-access-token",
        refresh_token: "fake-refresh-token",
        expires_in: 3600,
        scope: LINEAR_APP_SCOPES,
      });
    },
    async onAuthorize(link) {
      const auth = new URL(link);
      expect(auth.origin).toBe("https://linear.app");
      expect(auth.searchParams.get("actor")).toBe("app");
      expect(auth.searchParams.get("scope")).toBe(LINEAR_APP_SCOPES);
      challenge = auth.searchParams.get("code_challenge")!;
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      const state = auth.searchParams.get("state")!;
      expect(state.length).toBeGreaterThanOrEqual(32);
      redirectUri = auth.searchParams.get("redirect_uri")!;
      const callback = new URL(redirectUri);
      expect(callback.hostname).toBe("localhost");
      expect(callback.pathname).toBe("/oauth/callback");
      expect((await fetch(new URL("/other", callback))).status).toBe(404);
      expect((await fetch(callback, { method: "POST" })).status).toBe(405);
      callback.searchParams.set("code", "fake-code");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", "wrong-state");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", state);
      callback.searchParams.delete("code");
      expect((await fetch(callback)).status).toBe(400);
      expect(exchanges).toBe(0);
      callback.searchParams.set("code", "fake-code");
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Return to Paws");
      expect(body).not.toContain("fake-access-token");
      expect(body).not.toContain("fake-refresh-token");
      expect((await fetch(callback)).status).toBe(409);
    },
  });
  expect(exchanges).toBe(1);
  expect(token).toMatchObject({
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    actor: "app",
    scope: LINEAR_APP_SCOPES,
  });
  expect(token.expiresAtMs).toBeGreaterThanOrEqual(started + 3_600_000);
  await expect(fetch(redirectUri)).rejects.toThrow();
});

test("Linear callback handles denied consent without exchanging or reflecting errors", async () => {
  let callback = "";
  await expect(
    authorizeLinear({
      clientId: "client-1",
      clientSecret: "fake-client-secret",
      port: 0,
      timeoutMs: 2_000,
      fetch: async () => {
        throw new Error("unexpected token exchange");
      },
      async onAuthorize(link) {
        const auth = new URL(link);
        const url = new URL(auth.searchParams.get("redirect_uri")!);
        callback = url.href;
        url.searchParams.set("state", auth.searchParams.get("state")!);
        url.searchParams.set("error", "access_denied");
        url.searchParams.set("error_description", "private-provider-error");
        const response = await fetch(url);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("private-provider-error");
      },
    }),
  ).rejects.toThrow("Linear authorization was denied");
  await expect(fetch(callback)).rejects.toThrow();
});

test("Linear callback hides token exchange errors and closes its listener", async () => {
  let callback = "";
  await expect(
    authorizeLinear({
      clientId: "client-1",
      clientSecret: "fake-client-secret",
      port: 0,
      timeoutMs: 2_000,
      fetch: async () => {
        throw new Error("fake-client-secret fake-code");
      },
      async onAuthorize(link) {
        const auth = new URL(link);
        const url = new URL(auth.searchParams.get("redirect_uri")!);
        callback = url.href;
        url.searchParams.set("state", auth.searchParams.get("state")!);
        url.searchParams.set("code", "fake-code");
        const response = await fetch(url);
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain("fake-client-secret");
      },
    }),
  ).rejects.toThrow("Could not exchange the Linear authorization code");
  await expect(fetch(callback)).rejects.toThrow();
});

test("Linear callback timeout aborts an outstanding token exchange and releases the port", async () => {
  let callback = "";
  let signal: AbortSignal | undefined;
  const fetchToken: FetchLike = async (_input, init) => {
    signal = init?.signal ?? undefined;
    await new Promise((_, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
    throw new Error("unreachable");
  };
  await expect(
    authorizeLinear({
      clientId: "client-1",
      clientSecret: "fake-client-secret",
      port: 0,
      timeoutMs: 100,
      fetch: fetchToken,
      async onAuthorize(link) {
        const auth = new URL(link);
        const url = new URL(auth.searchParams.get("redirect_uri")!);
        callback = url.href;
        url.searchParams.set("state", auth.searchParams.get("state")!);
        url.searchParams.set("code", "fake-code");
        await fetch(url).catch(() => undefined);
      },
    }),
  ).rejects.toThrow("Linear authorization timed out");
  expect(signal?.aborted).toBe(true);
  await expect(fetch(callback)).rejects.toThrow();
});

test("Linear callback closes its listener when presenting authorization fails", async () => {
  let callback = "";
  await expect(
    authorizeLinear({
      clientId: "client-1",
      clientSecret: "fake-client-secret",
      port: 0,
      onAuthorize(link) {
        callback = new URL(link).searchParams.get("redirect_uri")!;
        throw new Error("display failed");
      },
    }),
  ).rejects.toThrow("display failed");
  await expect(fetch(callback)).rejects.toThrow();
});
