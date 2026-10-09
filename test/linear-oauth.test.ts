import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  LINEAR_ACTOR,
  LINEAR_APP_SCOPES,
  createLinearAuth,
  createLinearClient,
  exchangeLinearCode,
  linearAuthorizeUrl,
  readStoredToken,
  writeStoredToken,
  type FetchLike,
} from "../src/linear";
import { tempHome } from "./helpers";

describe("linear oauth", () => {
  test("authorize url installs the app actor with agent scopes", () => {
    const url = new URL(
      linearAuthorizeUrl({
        clientId: "client-1",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        state: "state-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("actor")).toBe(LINEAR_ACTOR);
    expect(url.searchParams.get("scope")).toBe(LINEAR_APP_SCOPES);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  test("refresh rotates the stored token and keeps the file private", async () => {
    const home = tempHome();
    const tokenPath = join(home, "linear-oauth.json");
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-1");
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "read write",
      });
    };
    const auth = createLinearAuth({
      tokenPath,
      clientId: "client-1",
      clientSecret: "secret-1",
      bootstrapAccessToken: "access-1",
      bootstrapRefreshToken: "refresh-1",
      fetch: fetchImpl,
      now: () => 1_000,
    });
    expect(auth.hasToken()).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const access = await auth.ensureFresh();
    expect(access).toBe("access-2");
    expect(readStoredToken(tokenPath)).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      actor: "app",
      expiresAtMs: 1_000 + 3_600_000,
    });
    chmodSync(tokenPath, 0o600);
    const again = await auth.ensureFresh();
    expect(again).toBe("access-2");
    expect(calls).toHaveLength(1);
  });

  test("a 401 refreshes once and retries the GraphQL call", async () => {
    const home = tempHome();
    const tokenPath = join(home, "linear-oauth.json");
    const graphql: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return Response.json({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        });
      }
      const header = new Headers(init?.headers).get("authorization");
      graphql.push(header ?? "");
      if (header === "Bearer access-1") return new Response("no", { status: 401 });
      return Response.json({ data: { viewer: { id: "app-user" } } });
    };
    const auth = createLinearAuth({
      tokenPath,
      clientId: "client-1",
      clientSecret: "secret-1",
      bootstrapAccessToken: "access-1",
      bootstrapRefreshToken: "refresh-1",
      fetch: fetchImpl,
      now: () => 5_000,
    });
    const stored = readStoredToken(tokenPath);
    if (stored === null) throw new Error("missing token");
    writeStoredToken(tokenPath, { ...stored, expiresAtMs: 5_000 + 60 * 60 * 1000 });
    const client = createLinearClient({ auth, fetch: fetchImpl });
    const data = (await client.query("query { viewer { id } }")) as { viewer: { id: string } };
    expect(data.viewer.id).toBe("app-user");
    expect(graphql).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  test("exchanges an authorization code without echoing the token on failure", async () => {
    const token = await exchangeLinearCode({
      clientId: "client-1",
      clientSecret: "secret-1",
      code: "code-1",
      redirectUri: "http://127.0.0.1:8787/callback",
      now: 10,
      fetch: async (_input, init) => {
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("code-1");
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 10,
        });
      },
    });
    expect(token.accessToken).toBe("access-1");
    expect(token.expiresAtMs).toBe(10_010);
    await expect(
      exchangeLinearCode({
        clientId: "client-1",
        clientSecret: "secret-1",
        code: "nope",
        redirectUri: "http://127.0.0.1/callback",
        fetch: async () => new Response("refresh-1 access-1", { status: 400 }),
      }),
    ).rejects.toThrow("HTTP 400");
  });
});
