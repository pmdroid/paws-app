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

  test("a repository named in another case is the same repository, and another one is refused", () => {
    const body = (repository: { name: string; full_name: string }) =>
      tokenBody("ghs_case", { repositories: [repository] });
    const scoped = assertScopedToken(
      body({ name: "Monorepo", full_name: "Acme/Monorepo" }),
      "acme",
      "monorepo",
      new Date(),
    );
    expect(scoped.token).toBe("ghs_case");
    expect(() =>
      assertScopedToken(
        body({ name: "other", full_name: "Acme/other" }),
        "acme",
        "monorepo",
        new Date(),
      ),
    ).toThrow(/does not match/);
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
