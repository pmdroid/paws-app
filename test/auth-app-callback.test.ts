import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { authorizeGitHubApp } from "../src/auth";

test("GitHub callback validates state, PKCE, request method and single-use code", async () => {
  let challenge = "";
  let callback = "";
  let exchanges = 0;
  const grant = await authorizeGitHubApp({
    clientId: "Iv1.fake-app",
    clientSecret: "fake-secret",
    port: 0,
    timeoutMs: 2_000,
    fetch: async (url, init) => {
      exchanges += 1;
      expect(url).toBe("https://github.com/login/oauth/access_token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("redirect_uri")).toBe(callback);
      expect(body.get("client_secret")).toBe("fake-secret");
      expect(body.get("code")).toBe("fake-code");
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
        challenge,
      );
      return Response.json({
        access_token: "fake-user-token",
        expires_in: 28800,
        refresh_token: "fake-refresh",
        scope: "",
      });
    },
    async onAuthorize(link) {
      const auth = new URL(link);
      expect(auth.origin).toBe("https://github.com");
      expect(auth.searchParams.has("scope")).toBe(false);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      challenge = auth.searchParams.get("code_challenge")!;
      callback = auth.searchParams.get("redirect_uri")!;
      const url = new URL(callback);
      expect(url.hostname).toBe("127.0.0.1");
      expect((await fetch(new URL("/other", url))).status).toBe(404);
      expect((await fetch(url, { method: "POST" })).status).toBe(405);
      url.searchParams.set("code", "fake-code");
      expect((await fetch(url)).status).toBe(400);
      url.searchParams.set("state", "wrong");
      expect((await fetch(url)).status).toBe(400);
      url.searchParams.set("state", auth.searchParams.get("state")!);
      url.searchParams.delete("code");
      expect((await fetch(url)).status).toBe(400);
      url.searchParams.set("code", "fake-code");
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("fake-user-token");
      expect((await fetch(url)).status).toBe(409);
    },
  });
  expect(grant.accessToken).toBe("fake-user-token");
  expect(exchanges).toBe(1);
  await expect(fetch(callback)).rejects.toThrow();
});

test("GitHub callback rejects denial and hides exchange errors, then closes its listener", async () => {
  for (const failure of ["denied", "exchange"] as const) {
    let callback = "";
    await expect(
      authorizeGitHubApp({
        clientId: "Iv1.fake-app",
        clientSecret: "fake-secret",
        port: 0,
        timeoutMs: 2_000,
        fetch: async () => {
          throw new Error("fake-secret private-provider-error");
        },
        async onAuthorize(link) {
          const auth = new URL(link);
          callback = auth.searchParams.get("redirect_uri")!;
          const url = new URL(callback);
          url.searchParams.set("state", auth.searchParams.get("state")!);
          url.searchParams.set(failure === "denied" ? "error" : "code", "private-provider-error");
          const response = await fetch(url);
          expect(response.status).toBe(failure === "denied" ? 400 : 502);
          expect(await response.text()).not.toContain("private-provider-error");
        },
      }),
    ).rejects.toThrow(failure === "denied" ? "authorization was denied" : "Could not exchange");
    await expect(fetch(callback)).rejects.toThrow();
  }
});

test("GitHub callback timeout aborts an exchange and releases the port", async () => {
  let signal: AbortSignal | undefined;
  let callback = "";
  await expect(
    authorizeGitHubApp({
      clientId: "Iv1.fake-app",
      clientSecret: "fake-secret",
      port: 0,
      timeoutMs: 100,
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        await new Promise((_, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        );
        throw new Error("unreachable");
      },
      async onAuthorize(link) {
        const auth = new URL(link);
        callback = auth.searchParams.get("redirect_uri")!;
        const url = new URL(callback);
        url.searchParams.set("state", auth.searchParams.get("state")!);
        url.searchParams.set("code", "fake-code");
        await fetch(url).catch(() => undefined);
      },
    }),
  ).rejects.toThrow("authorization timed out");
  expect(signal?.aborted).toBe(true);
  await expect(fetch(callback)).rejects.toThrow();
});
