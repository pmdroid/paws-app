import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitHubTokenProvider,
  createGitHubInstallationCheck,
  MISSING_GITHUB_APP_MESSAGE,
} from "../src/auth";
import { INSTALLATION_PERMISSIONS } from "../src/github";

const roots: string[] = [];
const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("repository work uses App installation tokens and the App bot identity", async () => {
  const scene = fixture();
  const provider = createGitHubTokenProvider({
    auth: "app",
    repo: "acme/widgets",
    appId: "99",
    installationId: "22",
    privateKeyPem: key,
    fetch: scene.options.fetch,
  });
  expect(provider.source).toBe("app");
  expect(await provider.token()).toBe("fake-installation-token");
  expect(await provider.user()).toEqual({ login: "paws-test[bot]", id: 88 });
  expect(await provider.botIdentity?.()).toEqual({
    appId: "99",
    login: "paws-test[bot]",
    id: 88,
  });
  expect(scene.calls.some((call) => call.path === "/user")).toBe(false);
});

test("missing App credentials fail with a message that names the GitHub App doc", () => {
  for (const missing of ["appId", "installationId", "privateKeyPem"] as const) {
    const config = {
      repo: "acme/widgets",
      appId: "99",
      installationId: "22",
      privateKeyPem: key,
      [missing]: null,
    };
    expect(() => createGitHubTokenProvider(config)).toThrow(MISSING_GITHUB_APP_MESSAGE);
  }
  expect(MISSING_GITHUB_APP_MESSAGE).toContain("docs/github-app.md");
  expect(() =>
    createGitHubTokenProvider({
      auth: "oauth" as never,
      repo: "acme/widgets",
      appId: "99",
      installationId: "22",
      privateKeyPem: key,
    }),
  ).toThrow('github.auth must be "app"');
});

test("installation checks use App authority without reading a saved human token", async () => {
  const scene = fixture();
  const check = createGitHubInstallationCheck({
    home: scene.home,
    env: { ...scene.options.env, GITHUB_APP_INSTALLATION_ID: "22" },
    fetch: scene.options.fetch,
  });
  expect(await check("acme/widgets", "write", new AbortController().signal)).toBe(true);
  expect(scene.calls.some((call) => call.path === "/user")).toBe(false);
});

test("installation checks reject revoked, foreign and permission-reduced installations", async () => {
  for (const failure of ["installation", "permissions"] as const) {
    const scene = fixture(failure);
    const check = createGitHubInstallationCheck({
      home: scene.home,
      env: { ...scene.options.env, GITHUB_APP_INSTALLATION_ID: "22" },
      fetch: scene.options.fetch,
    });
    expect(await check("acme/widgets", "write", new AbortController().signal)).toBe(false);
  }
  const scene = fixture();
  const check = createGitHubInstallationCheck({
    home: scene.home,
    env: { ...scene.options.env, GITHUB_APP_INSTALLATION_ID: "23" },
    fetch: scene.options.fetch,
  });
  expect(await check("acme/widgets", "write", new AbortController().signal)).toBe(false);
});

function fixture(failure?: "client" | "installation" | "permissions") {
  const home = mkdtempSync(join(tmpdir(), "paws-auth-app-"));
  roots.push(home);
  const privateKeyPath = join(home, "source.pem");
  writeFileSync(privateKeyPath, key, { mode: 0o600 });
  const calls: { path: string; token: string | null }[] = [];
  const options = {
    env: {
      PAWS_HOME: home,
      GITHUB_APP_ID: "99",
      PAWS_GITHUB_CLIENT_ID: "Iv1.fake-app",
      PAWS_GITHUB_CLIENT_SECRET: "fake-app-client-secret",
      GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
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
        return Response.json({ login: "paws-test[bot]", id: 88, type: "Bot" });
      }
      throw new Error(`Unexpected fake GitHub request ${input}`);
    },
  };
  return { home, options, calls };
}
