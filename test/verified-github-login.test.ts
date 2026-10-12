import { describe, expect, test } from "bun:test";
import {
  createVerifiedGitHubLogin,
  createTokenStore,
  type GitHubTokenStore,
  type StoredGitHubOAuth,
} from "../src/auth";

function keychainFixture() {
  let token: StoredGitHubOAuth = {
    id: 7,
    login: "owner",
    accessToken: "fake-old-token",
    refreshToken: null,
    expiresAtMs: null,
    scope: "repo read:org",
    invalid: false,
  };
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let pauseWrite = true;
  const options = {
    home: `/tmp/paws-offline-keychain-${crypto.randomUUID()}`,
    platform: "darwin" as const,
    which: () => "/fake/security",
    async run(_command: string, args: readonly string[], stdin?: string) {
      if (args[0] === "find-generic-password")
        return { code: 0, stdout: JSON.stringify(token), stderr: "" };
      if (args[0] !== "add-generic-password") throw new Error("Unexpected keychain command");
      if (pauseWrite) {
        pauseWrite = false;
        started.resolve();
        await released.promise;
      }
      token = JSON.parse(stdin!) as StoredGitHubOAuth;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return {
    store: createTokenStore(options),
    operator: createTokenStore(options),
    started: started.promise,
    release: () => released.resolve(),
    latest: () => ({
      ...token,
      id: 8,
      login: "new-owner",
      accessToken: "fake-new-owner-token",
      invalid: false,
    }),
  };
}

function fixture() {
  let token: StoredGitHubOAuth = {
    id: 7,
    login: "owner",
    accessToken: "fake-old-token",
    refreshToken: null,
    expiresAtMs: null,
    scope: "repo read:org",
    invalid: true,
  };
  const saves: StoredGitHubOAuth[] = [];
  const store: GitHubTokenStore = {
    backend: "file",
    warning: null,
    async load() {
      return token;
    },
    async save(value) {
      saves.push(value);
      token = value;
    },
    async update(change) {
      const next = change(token);
      if (next === null) return false;
      await store.save(next);
      return true;
    },
    async markInvalid() {
      token = { ...token, invalid: true };
    },
    async delete() {},
  };
  let accountId = 7;
  let status = 200;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const login = createVerifiedGitHubLogin({
    home: "/tmp/paws-offline-auth",
    env: {},
    auth: "oauth",
    oauthClientId: "fake-client-id",
    store,
    async fetch(url, init) {
      requests.push({ url, init });
      if (url.endsWith("/login/device/code"))
        return Response.json({
          device_code: "fake-private-device-code",
          user_code: "LOCAL-CODE",
          verification_uri: "https://github.example/device",
          expires_in: 600,
          interval: 1,
        });
      if (url.endsWith("/login/oauth/access_token"))
        return Response.json({
          access_token: "fake-new-token",
          token_type: "bearer",
          scope: "repo read:org",
        });
      if (url.endsWith("/user"))
        return Response.json(
          { id: accountId, login: "owner" },
          { status, headers: { "x-oauth-scopes": "repo,read:org" } },
        );
      throw new Error(`Unexpected fake URL ${url}`);
    },
  });
  return {
    login,
    store,
    saves,
    requests,
    setAccount: (id: number) => {
      accountId = id;
    },
    setStatus: (value: number) => {
      status = value;
    },
  };
}

describe("host GitHub sign-in verification", () => {
  test.each(["authorization", "invalidation"] as const)(
    "serializes a delayed %s keychain write before a concurrent host account replacement",
    async (phase) => {
      const f = keychainFixture();
      const host = createVerifiedGitHubLogin({
        home: "/tmp/paws-offline-auth",
        store: f.store,
        auth: "oauth",
        oauthClientId: "fake-client-id",
        env: {},
        fetch: async (url) => {
          if (url.endsWith("/login/device/code"))
            return Response.json({
              device_code: "fake-device",
              user_code: "LOCAL-CODE",
              verification_uri: "https://github.example/device",
              expires_in: 600,
              interval: 1,
            });
          if (url.endsWith("/login/oauth/access_token"))
            return Response.json({
              access_token: "fake-new-token",
              token_type: "bearer",
              scope: "repo read:org",
            });
          return phase === "invalidation"
            ? Response.json({}, { status: 401 })
            : Response.json(
                { id: 7, login: "owner" },
                { headers: { "x-oauth-scopes": "repo,read:org" } },
              );
        },
      });
      const pending =
        phase === "authorization"
          ? (
              await host.begin({
                signal: new AbortController().signal,
                acceptAccount: (id) => id === 7,
              })
            ).completed
          : host.check(new AbortController().signal);
      await f.started;
      const replacement = f.operator.save(f.latest());
      f.release();
      await pending;
      await replacement;
      expect(await f.store.load()).toMatchObject({
        id: 8,
        invalid: false,
        accessToken: "fake-new-owner-token",
      });
    },
  );
  test("uses the real configured device exchange and verifies account before saving", async () => {
    const f = fixture();
    const controller = new AbortController();
    const challenge = await f.login.begin({
      signal: controller.signal,
      acceptAccount: (id) => id === 7,
    });
    expect(challenge.body).toContain("LOCAL-CODE");
    expect(challenge.url).toBe("https://github.example/device");
    expect(await challenge.completed).toEqual({ id: 7, login: "owner" });
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]?.accessToken).toBe("fake-new-token");
    expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/login/device/code",
      "/login/oauth/access_token",
      "/user",
    ]);
  });

  test("account mismatch cannot replace the saved host credential", async () => {
    const f = fixture();
    f.setAccount(8);
    const challenge = await f.login.begin({
      signal: new AbortController().signal,
      acceptAccount: (id) => id === 7,
    });
    await expect(challenge.completed).rejects.toThrow("does not match");
    expect(f.saves).toHaveLength(0);
    expect((await f.store.load())?.accessToken).toBe("fake-old-token");
  });

  test("revoked requests cannot replace the saved host credential", async () => {
    const f = fixture();
    const controller = new AbortController();
    const challenge = await f.login.begin({ signal: controller.signal, acceptAccount: () => true });
    controller.abort();
    await expect(challenge.completed).rejects.toThrow();
    expect(f.saves).toHaveLength(0);
  });

  test("an old authorization cannot overwrite a newly linked host account", async () => {
    const f = fixture();
    const flow = await f.login.begin({
      signal: new AbortController().signal,
      acceptAccount: (id) => id === 7,
    });
    await f.store.save({
      ...(await f.store.load())!,
      id: 8,
      login: "new-owner",
      accessToken: "fake-new-owner-token",
    });
    f.saves.length = 0;
    await expect(flow.completed).rejects.toThrow("does not match");
    expect(f.saves).toHaveLength(0);
    expect(await f.store.load()).toMatchObject({ id: 8, accessToken: "fake-new-owner-token" });
  });

  test("preflight verifies the server account and invalidates rejected tokens", async () => {
    const f = fixture();
    const stored = (await f.store.load())!;
    await f.store.save({ ...stored, invalid: false });
    f.saves.length = 0;
    const signal = new AbortController().signal;
    expect(await f.login.check(signal)).toEqual({ id: 7, login: "owner" });
    expect(f.requests[0]?.init?.signal).toBe(signal);
    f.setAccount(8);
    expect(await f.login.check(signal)).toBeNull();
    f.setStatus(401);
    expect(await f.login.check(signal)).toBeNull();
    expect((await f.store.load())?.invalid).toBe(true);
    expect(await f.login.linkedAccount()).toBe(7);
  });

  test.each([200, 401])(
    "a late %s response cannot use or invalidate a newly linked host account",
    async (status) => {
      const f = fixture();
      await f.store.save({ ...(await f.store.load())!, invalid: false });
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      const host = createVerifiedGitHubLogin({
        home: "/tmp/paws-offline-auth",
        store: f.store,
        fetch: async () => {
          started.resolve();
          return response.promise;
        },
      });
      const checked = host.check(new AbortController().signal);
      await started.promise;
      await f.store.save({
        ...(await f.store.load())!,
        id: 8,
        login: "new-owner",
        accessToken: "fake-new-owner-token",
      });
      response.resolve(
        Response.json(
          { id: 7, login: "owner" },
          {
            status,
            headers: { "x-oauth-scopes": "repo,read:org" },
          },
        ),
      );
      expect(await checked).toBeNull();
      expect(await f.store.load()).toMatchObject({
        id: 8,
        invalid: false,
        accessToken: "fake-new-owner-token",
      });
    },
  );
});
