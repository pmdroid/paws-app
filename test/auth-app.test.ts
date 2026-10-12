import { readSecretFile } from "../src/credentials";
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitHubTokenProvider,
  createDashboardGitHubAuth,
  createVerifiedGitHubLogin,
  createTokenStore,
  githubOAuthPath,
  loginGitHub,
  readSignedInUser,
} from "../src/auth";
import { loadRuntime, pawsPaths } from "../src/config";
import { INSTALLATION_PERMISSIONS } from "../src/github";
import { handleStatusRequest } from "../src/web";

const roots: string[] = [];
const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("GitHub App sign-in persists private credentials and repository work uses only bot tokens", async () => {
  const scene = fixture();
  writeFileSync(
    pawsPaths(scene.home).configFile,
    '[github]\nauth = "gh"\nrepo = "old/repo"\n[agents]\nimplementer = "codex"\n[tracker]\nkind = "github"\n',
  );
  scene.options.env = {
    ...scene.options.env,
    ...{ GITHUB_WEBHOOK_SECRET: "synthetic-github-webhook-secret" },
  };
  const user = await loginGitHub(scene.options);
  expect(user).toEqual({ login: "octocat", id: 7 });
  expect(await readSignedInUser({ store: scene.store })).toEqual(user);
  expect((await scene.store.load())?.appId).toBe("99");
  expect((await scene.store.load())?.expiresAtMs).toBeGreaterThan(Date.now());
  const runtime = loadRuntime({ PAWS_HOME: scene.home });
  expect(runtime.env.githubWebhookSecret).toBe("synthetic-github-webhook-secret");
  expect(readFileSync(join(scene.home, "secrets", "github-webhook"), "utf8")).not.toContain(
    "synthetic-github-webhook-secret",
  );
  expect(runtime.githubAuth).toBe("app");
  expect(runtime.repo).toBe("acme/widgets");
  expect(runtime.file.agents.implementer).toBe("codex");
  expect(runtime.env.githubAppInstallationId).toBe("22");
  const config = readFileSync(pawsPaths(scene.home).configFile, "utf8");
  expect(config).not.toContain("fake-app-client-secret");
  expect(config).not.toContain("fake-user-token");
  for (const path of [
    githubOAuthPath(scene.home),
    join(scene.home, "secrets/github-app.json"),
    runtime.env.githubAppPrivateKeyPath!,
  ])
    expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(scene.home, "secrets")).mode & 0o777).toBe(0o700);
  expect(readSecretFile(runtime.env.githubAppPrivateKeyPath!)).toBe(key);
  const provider = createGitHubTokenProvider({
    auth: runtime.githubAuth,
    repo: runtime.repo,
    appId: runtime.env.githubAppId,
    installationId: runtime.env.githubAppInstallationId,
    privateKeyPem: key,
    fetch: scene.options.fetch,
  });
  expect(await provider.token()).toBe("fake-installation-token");
  expect(await provider.user()).toEqual({ login: "paws-test[bot]", id: 88 });
  const before = scene.calls.length;
  expect(await provider.user()).toEqual({ login: "paws-test[bot]", id: 88 });
  expect(scene.calls.length).toBe(before);
  expect(scene.calls.filter((call) => call.path === "/user").map((call) => call.token)).toEqual([
    "Bearer fake-user-token",
  ]);
  expect(scene.output.join("\n")).toContain("Signed in as octocat");
  expect(scene.output.join("\n")).not.toContain("fake-app-client-secret");
  expect(scene.output.join("\n")).not.toContain("fake-user-token");
});

test("GitHub App login rejects mismatched credentials and missing installations before opening a browser", async () => {
  for (const failure of ["client", "installation"] as const) {
    const scene = fixture(failure);
    await expect(loginGitHub(scene.options)).rejects.toThrow(
      failure === "client"
        ? "must belong to the same app"
        : "https://github.com/apps/paws-test/installations/new",
    );
    expect(scene.opened()).toBe(0);
    expect(await scene.store.load()).toBeNull();
    expect(existsSync(join(scene.home, "secrets/github-app.json"))).toBe(false);
  }
});

test("dashboard App sign-in provides a browser URL and completes through the callback", async () => {
  const scene = fixture();
  const githubAuth = createDashboardGitHubAuth(scene.options);
  const response = await handleStatusRequest(
    new Request("http://127.0.0.1/api/auth/github/device", {
      method: "POST",
      headers: { "x-paws-csrf": "fake-csrf" },
    }),
    { githubAuth, csrfToken: "fake-csrf" },
  );
  expect(response?.status).toBe(200);
  const started = (await response!.json()) as { userCode: string; verificationUri: string };
  expect(started.userCode).toBe("");
  const auth = new URL(started.verificationUri);
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  url.searchParams.set("state", auth.searchParams.get("state")!);
  url.searchParams.set("code", "fake-code");
  expect((await fetch(url)).status).toBe(200);
  for (let attempt = 0; attempt < 100 && (await githubAuth.user()) === null; attempt += 1)
    await Bun.sleep(5);
  expect(await githubAuth.user()).toEqual({ login: "octocat", id: 7 });
  expect(scene.opened()).toBe(0);
});

test("Linear host sign-in verifies the saved human through the configured App callback", async () => {
  const scene = fixture();
  await scene.store.save({
    id: 7,
    login: "octocat",
    accessToken: "fake-old-user-token",
    refreshToken: null,
    expiresAtMs: null,
    scope: "",
    invalid: true,
  });
  const host = createVerifiedGitHubLogin(scene.options);
  const controller = new AbortController();
  expect(await host.linkedAccount()).toBe(7);
  expect(await host.check(controller.signal)).toBeNull();
  const flow = await host.begin({ signal: controller.signal, acceptAccount: (id) => id === 7 });
  const auth = new URL(flow.url);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "fake-code");
  callback.searchParams.set("state", "wrong-state");
  expect((await fetch(callback)).status).toBe(400);
  expect((await scene.store.load())?.accessToken).toBe("fake-old-user-token");
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  expect((await fetch(callback)).status).toBe(200);
  expect(await flow.completed).toEqual({ id: 7, login: "octocat" });
  expect(await host.check(controller.signal)).toEqual({ id: 7, login: "octocat" });
  expect(
    scene.calls
      .filter((call) => call.path === "/user")
      .every((call) => call.token === "Bearer fake-user-token"),
  ).toBe(true);
});

test("GitHub App login leaves configuration untouched when user access or bot permissions fail", async () => {
  for (const failure of ["push", "permissions"] as const) {
    const scene = fixture(failure);
    await expect(loginGitHub(scene.options)).rejects.toThrow(
      failure === "push" ? "must have push access" : "issues permission must be write",
    );
    expect(await scene.store.load()).toBeNull();
    expect(existsSync(join(scene.home, "secrets/github-app.json"))).toBe(false);
    expect(existsSync(pawsPaths(scene.home).configFile)).toBe(false);
  }
});

function fixture(failure?: "client" | "installation" | "push" | "permissions") {
  const home = mkdtempSync(join(tmpdir(), "paws-auth-app-"));
  roots.push(home);
  const privateKeyPath = join(home, "source.pem");
  writeFileSync(privateKeyPath, key, { mode: 0o600 });
  const store = createTokenStore({ home, which: () => null });
  const output: string[] = [];
  const calls: { path: string; token: string | null }[] = [];
  let opened = 0;
  const options = {
    auth: "app" as const,
    repo: "acme/widgets",
    home,
    store,
    port: 0,
    timeoutMs: 2_000,
    env: {
      PAWS_HOME: home,
      GITHUB_APP_ID: "99",
      PAWS_GITHUB_CLIENT_ID: "Iv1.fake-app",
      PAWS_GITHUB_CLIENT_SECRET: "fake-app-client-secret",
      GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
    },
    stdout: (line: string) => output.push(line),
    async openBrowser(link: string) {
      opened += 1;
      const auth = new URL(link);
      const url = new URL(auth.searchParams.get("redirect_uri")!);
      url.searchParams.set("state", auth.searchParams.get("state")!);
      url.searchParams.set("code", "fake-code");
      expect((await fetch(url)).status).toBe(200);
    },
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      const url = new URL(input);
      const token = new Headers(init?.headers).get("authorization");
      calls.push({ path: url.pathname, token });
      if (url.pathname === "/app")
        return Response.json({
          id: 99,
          slug: "paws-test",
          client_id: failure === "client" ? "another-client" : "Iv1.fake-app",
        });
      if (url.pathname === "/repos/acme/widgets/installation")
        return failure === "installation"
          ? new Response(null, { status: 404 })
          : Response.json({ id: 22 });
      if (url.pathname === "/login/oauth/access_token")
        return Response.json({ access_token: "fake-user-token", expires_in: 28800, scope: "" });
      if (url.pathname === "/user") {
        expect(token).toBe("Bearer fake-user-token");
        return Response.json({ login: "octocat", id: 7 });
      }
      if (url.pathname === "/repos/acme/widgets")
        return Response.json({ permissions: { push: failure !== "push" } });
      if (url.pathname === "/app/installations/22/access_tokens") {
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["widgets"],
          permissions: INSTALLATION_PERMISSIONS,
        });
        return Response.json(
          {
            token: "fake-installation-token",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "widgets", full_name: "acme/widgets" }],
            permissions: {
              ...INSTALLATION_PERMISSIONS,
              issues: failure === "permissions" ? "read" : "write",
            },
          },
          { status: 201 },
        );
      }
      if (decodeURIComponent(url.pathname) === "/users/paws-test[bot]") {
        expect(token).toBe("Bearer fake-installation-token");
        return Response.json({ login: "paws-test[bot]", id: 88 });
      }
      throw new Error(`Unexpected fake GitHub request ${input}`);
    },
  };
  return { home, options, store, calls, output, opened: () => opened };
}
