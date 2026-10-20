import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, listRepositoryCatalog, putWorkspaceUser } from "../src/db";
import { INSTALLATION_PERMISSIONS } from "../src/github";
import { startPaws } from "../src/index";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { tempHome } from "./helpers";

const appKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function linearResponse(query: string, variables: Record<string, unknown>) {
  const viewer = { id: "app", app: true, organization: { id: "org" } };
  if (query.includes("PawsBrowserInstallation"))
    return { viewer: { app: true, organization: { id: "org", name: "Local workspace" } } };
  if (query.includes("PawsBrowserMembership"))
    return {
      viewer,
      user: {
        id: variables.id,
        active: true,
        guest: false,
        admin: false,
        organization: { id: "org" },
        teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    };
  if (query.includes("PawsRepositoryTeams"))
    return {
      viewer,
      teams: {
        nodes: [{ id: "team", name: "Engineering", key: "ENG" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  if (query.includes("query PawsInstallation")) return { viewer };
  return null;
}

function githubResponse(path: string, method: string, body: string, catalog: string[]) {
  if (path === "/login/oauth/access_token")
    return Response.json({ access_token: "scripted-user-token" });
  if (path === "/user") return Response.json({ id: 7, login: "installer" });
  if (path === "/app")
    return Response.json({ id: 99, client_id: "Iv1.fake", slug: "fixture-paws" });
  if (path === "/user/installations")
    return Response.json({
      total_count: 1,
      installations: [
        { id: 22, app_id: 99, account: { login: "acme" }, permissions: INSTALLATION_PERMISSIONS },
      ],
    });
  if (path === "/user/installations/22/repositories")
    return Response.json({
      total_count: 1,
      repositories: [
        { id: 1, full_name: "acme/widgets", private: true, permissions: { admin: true } },
      ],
    });
  if (path === "/repos/acme/widgets/installation")
    return Response.json({
      id: 22,
      app_id: 99,
      suspended_at: null,
      permissions: INSTALLATION_PERMISSIONS,
    });
  if (path === "/repos/acme/widgets")
    return Response.json({ permissions: { admin: true }, owner: { type: "Organization", id: 1 } });
  if (path === "/user/memberships/orgs/acme")
    return Response.json({ state: "active", role: "admin" });
  if (path === "/app/installations/22/access_tokens" && method === "POST") {
    const listing =
      JSON.stringify((JSON.parse(body || "{}") as { permissions?: unknown }).permissions) ===
      JSON.stringify({ metadata: "read" });
    return Response.json(
      {
        token: listing ? "scripted-list-token" : "scripted-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repository_selection: "selected",
        repositories: [{ name: "widgets", full_name: "acme/widgets" }],
        permissions: listing ? { metadata: "read" } : INSTALLATION_PERMISSIONS,
      },
      { status: 201 },
    );
  }
  if (path === "/installation/repositories") {
    catalog.push(path);
    return Response.json({
      total_count: 1,
      repositories: [
        {
          name: "widgets",
          full_name: "acme/widgets",
          owner: { login: "acme" },
          clone_url: "https://github.com/acme/widgets.git",
          default_branch: "main",
          archived: false,
        },
      ],
    });
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
}

for (const scenario of ["periodic", "normal", "shutdown"] as const)
  test(`GitHub setup catalog refresh through startPaws: ${scenario}`, async () => {
    const home = tempHome();
    const tls = join(home, "tls");
    mkdirSync(tls, { recursive: true, mode: 0o700 });
    const keyPath = join(tls, "server.key");
    const certPath = join(tls, "server.pem");
    const generated = Bun.spawnSync(
      [
        "/usr/bin/openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-config",
        "/dev/null",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: home } },
    );
    expect(generated.exitCode).toBe(0);
    chmodSync(keyPath, 0o600);
    const appKeyPath = join(tls, "github-app.pem");
    writeFileSync(appKeyPath, appKey, { mode: 0o600 });
    const ca = readFileSync(certPath, "utf8");
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    await reservation.stop(true);
    const origin = `https://127.0.0.1:${port}`;
    const catalogReads: string[] = [];
    const listingStarted = Promise.withResolvers<void>();
    const listingReleased = Promise.withResolvers<void>();
    const outbound: string[] = [];
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const url = new URL(request.url);
        const body = await request.text();
        outbound.push(`${request.method} ${url.host}${url.pathname}`);
        if (url.origin === "https://api.linear.app" && url.pathname === "/graphql") {
          const { query, variables } = JSON.parse(body) as {
            query: string;
            variables?: Record<string, unknown>;
          };
          const data = linearResponse(query, variables ?? {});
          if (data === null) throw new Error("Unexpected scripted Linear query");
          return Response.json({ data });
        }
        if (url.host === "github.com" || url.host === "api.github.com") {
          if (scenario === "shutdown" && url.pathname === "/installation/repositories") {
            listingStarted.resolve();
            await listingReleased.promise;
          }
          return githubResponse(url.pathname, request.method, body, catalogReads);
        }
        throw new Error(`Unexpected outbound request to ${url.host}`);
      },
      { preconnect: () => undefined },
    ) as typeof fetch;
    let paws: ReturnType<typeof startPaws> | undefined;
    try {
      paws = startPaws(
        {
          PATH: process.env.PATH,
          HOME: home,
          KYOTOAGENT_ROOT: join(home, ".kyotoagent"),
          PAWS_HOME: home,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
          PAWS_PORT: String(port),
          PAWS_HOST: "127.0.0.1",
          PAWS_PUBLIC_URL: origin,
          PAWS_PUBLIC_DASHBOARD: "1",
          PAWS_TLS_KEY_PATH: keyPath,
          PAWS_TLS_CERT_PATH: certPath,
          LINEAR_MODE: "agent-session",
          LINEAR_CLIENT_ID: "client",
          LINEAR_ACCESS_TOKEN: "fixture-access",
          LINEAR_APP_USER_ID: "app",
          LINEAR_WEBHOOKS: "true",
          LINEAR_WEBHOOK_SECRET: "fixture-webhook",
          GITHUB_AUTH: "app",
          GITHUB_APP_ID: "99",
          PAWS_GITHUB_CLIENT_ID: "Iv1.fake",
          PAWS_GITHUB_CLIENT_SECRET: "scripted-client-secret",
          GITHUB_APP_PRIVATE_KEY_PATH: appKeyPath,
        },
        { noTunnel: true, refreshRepositories: scenario === "periodic" },
      );
      const running = paws;
      await running.ready;
      const now = Date.now();
      const userId = putWorkspaceUser(running.db, {
        id: workspaceId(),
        linearUserId: "owner",
        name: "Owner",
        email: "owner@example.invalid",
      });
      const workspace = consumeWorkspaceBootstrap(running.db, {
        id: workspaceId(),
        organizationId: "org",
        name: "Local workspace",
        userId,
        tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(running.db, "org", now)),
        now,
      });
      const owner = issueWorkspaceSession(running.db, { userId, workspaceId: workspace.id, now });
      const call = (path: string, method = "GET", body?: unknown) =>
        nativeFetch(new URL(path, origin), {
          method,
          redirect: "manual",
          headers: {
            cookie: `${WORKSPACE_COOKIE}=${owner.token}`,
            ...(method === "GET"
              ? {}
              : {
                  origin,
                  "content-type": "application/json",
                  "x-paws-csrf": owner.session.csrfToken,
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          tls: { ca },
        } as RequestInit);
      let session = await call("/api/auth/session");
      for (let attempt = 0; attempt < 200 && session.status !== 200; attempt++) {
        await Bun.sleep(10);
        session = await call("/api/auth/session");
      }
      expect(session.status).toBe(200);
      const started = await call("/api/workspaces/github-setup", "POST", {});
      expect(started.status).toBe(200);
      const authorize = new URL(
        ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
      );
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("code", "scripted-code");
      expect((await call(callback.pathname + callback.search)).status).toBe(303);
      const choices = await call("/api/workspaces/github-setup");
      expect(choices.status).toBe(200);
      const { setupId } = (await choices.json()) as { setupId: string };
      expect(listRepositoryCatalog(running.db)).toEqual([]);
      const saving = call("/api/workspaces/github-setup", "PUT", {
        installationId: "22",
        mappings: [{ repository: "acme/widgets", teamId: "team" }],
        setupId,
      });
      if (scenario === "shutdown") {
        const disconnected = saving.catch(() => null);
        await listingStarted.promise;
        let joined = false;
        const stopping = running.stop().then(() => {
          joined = true;
        });
        try {
          await Bun.sleep(10);
          expect(joined).toBe(false);
          expect(listRepositoryCatalog(running.db)).toEqual([]);
        } finally {
          listingReleased.resolve();
          await stopping;
          await disconnected;
        }
        expect(joined).toBe(true);
        expect(() => listRepositoryCatalog(running.db)).toThrow();
        return;
      }
      const saved = await saving;
      expect(saved.status).toBe(200);
      expect(listRepositoryCatalog(running.db)).toEqual([
        {
          owner: "acme",
          repo: "widgets",
          remoteUrl: "https://github.com/acme/widgets.git",
          defaultBranch: "main",
        },
      ]);
      expect(await saved.json()).toEqual({ ok: true, catalogRefreshed: true });
      expect(catalogReads.length).toBeGreaterThanOrEqual(1);
      expect(outbound.filter((entry) => !/(api\.linear\.app|github\.com)/.test(entry))).toEqual([]);
    } finally {
      listingReleased.resolve();
      await paws?.stop();
      globalThis.fetch = nativeFetch;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
