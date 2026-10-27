import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { signAppJwt } from "./jwt";
import { createFetchGitHubClient } from "./client";
import { assertScopedToken, mintInstallationToken } from "./token";
import { INSTALLATION_PERMISSIONS, GitHubTokenError, type GitHubClient } from "./types";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

function tokenBody(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    repository_selection: "selected",
    repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
    permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
    ...overrides,
  };
}

describe("GitHub App tokens", () => {
  test("signs a short-lived RS256 JWT for the app id", () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const jwt = signAppJwt("12345", PRIVATE_KEY, now);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey as string, signature ?? "", "base64url")).toBe(true);
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe("12345");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(now.getTime() / 1000) + 600);
  });

  test("requests one repository and refuses a token that is too wide or too long-lived", async () => {
    const seen: unknown[] = [];
    const client: GitHubClient = {
      async request(req) {
        seen.push(req);
        return { status: 201, body: tokenBody("ghs_scoped") };
      },
    };
    const minted = await mintInstallationToken({
      client,
      appId: "99",
      installationId: "7",
      privateKeyPem: PRIVATE_KEY,
      owner: "pmdroid",
      repo: "paws-demo",
      now: new Date(),
    });
    expect(minted.token).toBe("ghs_scoped");
    const request = seen[0] as {
      body: { repositories: string[]; permissions: unknown };
      path: string;
    };
    expect(request.path).toBe("/app/installations/7/access_tokens");
    expect(request.body.repositories).toEqual(["paws-demo"]);
    expect(request.body.permissions).toEqual({ ...INSTALLATION_PERMISSIONS, workflows: "write" });

    const now = new Date("2026-10-09T12:00:00.000Z");
    expect(
      assertScopedToken(
        tokenBody("ghs_ok", { expires_at: "2026-10-09T13:00:00.000Z" }),
        "pmdroid",
        "paws-demo",
        now,
      ).token,
    ).toBe("ghs_ok");
    expect(() =>
      assertScopedToken(
        tokenBody("ghs_long", { expires_at: "2026-10-09T14:00:01.000Z" }),
        "pmdroid",
        "paws-demo",
        now,
      ),
    ).toThrow(GitHubTokenError);
    expect(() =>
      assertScopedToken(
        tokenBody("ghs_two", {
          expires_at: "2026-10-09T13:00:00.000Z",
          repositories: [
            { name: "paws-demo", full_name: "pmdroid/paws-demo" },
            { name: "other", full_name: "pmdroid/other" },
          ],
        }),
        "pmdroid",
        "paws-demo",
        now,
      ),
    ).toThrow(/exactly one repository/);
    expect(() =>
      assertScopedToken(
        tokenBody("ghs_all", {
          expires_at: "2026-10-09T13:00:00.000Z",
          repository_selection: "all",
        }),
        "pmdroid",
        "paws-demo",
        now,
      ),
    ).toThrow(/selected/);
  });

  test("a write token requests workflows and accepts it in the response", async () => {
    const seen: Array<{ body: { permissions: unknown } }> = [];
    const client: GitHubClient = {
      async request(req) {
        seen.push(req as { body: { permissions: unknown } });
        return {
          status: 201,
          body: tokenBody("ghs_workflows", {
            permissions: { ...INSTALLATION_PERMISSIONS, workflows: "write", metadata: "read" },
          }),
        };
      },
    };
    const minted = await mintInstallationToken({
      client,
      appId: "99",
      installationId: "801",
      privateKeyPem: PRIVATE_KEY,
      owner: "pmdroid",
      repo: "paws-demo",
      access: "write",
    });
    expect(minted.token).toBe("ghs_workflows");
    expect(seen.map((req) => req.body.permissions)).toEqual([
      { ...INSTALLATION_PERMISSIONS, workflows: "write" },
    ]);
  });

  test("an installation without workflows falls back once and remembers it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const client: GitHubClient = {
      async request(req) {
        const permissions = (req.body as { permissions: Record<string, unknown> }).permissions;
        seen.push(permissions);
        if ("workflows" in permissions) {
          return {
            status: 422,
            body: { message: "The permissions requested are not granted to this installation." },
          };
        }
        return { status: 201, body: tokenBody("ghs_without_workflows") };
      },
    };
    const mint = () =>
      mintInstallationToken({
        client,
        appId: "99",
        installationId: "802",
        privateKeyPem: PRIVATE_KEY,
        owner: "pmdroid",
        repo: "paws-demo",
      });
    expect((await mint()).token).toBe("ghs_without_workflows");
    expect(seen).toEqual([
      { ...INSTALLATION_PERMISSIONS, workflows: "write" },
      INSTALLATION_PERMISSIONS,
    ]);
    expect((await mint()).token).toBe("ghs_without_workflows");
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual(INSTALLATION_PERMISSIONS);
  });

  test("a 403 naming the permission falls back; one that does not is a failure", async () => {
    const refusal = (message: string) => {
      const seen: unknown[] = [];
      const client: GitHubClient = {
        async request(req) {
          const permissions = (req.body as { permissions: Record<string, unknown> }).permissions;
          seen.push(permissions);
          return "workflows" in permissions
            ? { status: 403, body: { message } }
            : { status: 201, body: tokenBody("ghs_fallback") };
        },
      };
      return { seen, client };
    };
    const named = refusal("The 'workflows' permission is not granted to this installation");
    const minted = await mintInstallationToken({
      client: named.client,
      appId: "99",
      installationId: "803",
      privateKeyPem: PRIVATE_KEY,
      owner: "pmdroid",
      repo: "paws-demo",
    });
    expect(minted.token).toBe("ghs_fallback");
    expect(named.seen).toHaveLength(2);

    const other = refusal("Resource not accessible by integration");
    await expect(
      mintInstallationToken({
        client: other.client,
        appId: "99",
        installationId: "804",
        privateKeyPem: PRIVATE_KEY,
        owner: "pmdroid",
        repo: "paws-demo",
      }),
    ).rejects.toThrow(/status 403/);
    expect(other.seen).toHaveLength(1);
  });

  test("a failed fallback is not remembered as a missing workflows permission", async () => {
    const seen: unknown[] = [];
    let fail = true;
    const client: GitHubClient = {
      async request(req) {
        seen.push((req.body as { permissions: unknown }).permissions);
        return fail
          ? { status: 422, body: { message: "repository is not accessible" } }
          : { status: 201, body: tokenBody("ghs_later") };
      },
    };
    const mint = () =>
      mintInstallationToken({
        client,
        appId: "99",
        installationId: "805",
        privateKeyPem: PRIVATE_KEY,
        owner: "pmdroid",
        repo: "paws-demo",
      });
    await expect(mint()).rejects.toThrow(/status 422/);
    expect(seen).toHaveLength(2);
    fail = false;
    await mint();
    expect(seen[2]).toEqual({ ...INSTALLATION_PERMISSIONS, workflows: "write" });
  });

  test("a read token never requests or accepts workflows", async () => {
    const seen: unknown[] = [];
    const client: GitHubClient = {
      async request(req) {
        seen.push((req.body as { permissions: unknown }).permissions);
        return {
          status: 201,
          body: tokenBody("ghs_read", { permissions: { contents: "read", metadata: "read" } }),
        };
      },
    };
    await mintInstallationToken({
      client,
      appId: "99",
      installationId: "806",
      privateKeyPem: PRIVATE_KEY,
      owner: "pmdroid",
      repo: "paws-demo",
      access: "read",
    });
    expect(seen).toEqual([{ contents: "read", metadata: "read" }]);
    expect(() =>
      assertScopedToken(
        tokenBody("ghs_read_workflows", {
          permissions: { contents: "read", metadata: "read", workflows: "read" },
        }),
        "pmdroid",
        "paws-demo",
        new Date(),
        "read",
      ),
    ).toThrow(/read token grants unexpected permissions/);
  });

  test("workflows must be read or write and other permissions are still refused", () => {
    const now = new Date();
    const withPermissions = (extra: Record<string, unknown>) =>
      tokenBody("ghs_extra", {
        permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read", ...extra },
      });
    expect(
      assertScopedToken(withPermissions({ workflows: "read" }), "pmdroid", "paws-demo", now).token,
    ).toBe("ghs_extra");
    expect(() =>
      assertScopedToken(withPermissions({ workflows: "admin" }), "pmdroid", "paws-demo", now),
    ).toThrow(/workflows permission must be read or write/);
    expect(() =>
      assertScopedToken(
        withPermissions({ workflows: "write", administration: "write" }),
        "pmdroid",
        "paws-demo",
        now,
      ),
    ).toThrow(/unexpected permission administration/);
  });

  test("the fetch client uses the injected fetch and does not require the network", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("real fetch");
    }) as unknown as typeof fetch;
    try {
      const calls: Array<{ url: string; authorization: string }> = [];
      const client = createFetchGitHubClient(async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), authorization: headers.get("authorization") ?? "" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const response = await client.request({
        method: "GET",
        path: "/repos/pmdroid/paws-demo",
        token: "ghs_header",
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        {
          url: "https://api.github.com/repos/pmdroid/paws-demo",
          authorization: "Bearer ghs_header",
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
