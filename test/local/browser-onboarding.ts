import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startPaws } from "../../src/index";
import { recordLinearInstallation, revokeLinearInstallation } from "../../src/db";

const root = resolve(process.argv[2]!);
mkdirSync(root, { recursive: true, mode: 0o700 });
const key = join(root, "server.key");
const cert = join(root, "server.crt");
assert.equal(
  Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  ).exitCode,
  0,
);
chmodSync(key, 0o600);
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const instancePath = join(root, "instance.json");
const port = existsSync(instancePath)
  ? Number(new URL(JSON.parse(readFileSync(instancePath, "utf8")).origin).port)
  : reservation.port!;
await reservation.stop(true);
const origin = `https://localhost:${port}`;
const nativeFetch = globalThis.fetch;
const organization = { id: "fixture-org", name: "Example workspace" };
const viewer = { id: "fixture-app", app: true, organization };
let grants = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/oauth/token") {
      const data = new URLSearchParams(await request.text());
      assert(data.has("code_verifier"));
      return Response.json({
        access_token: data.get("code") === "user-code" ? "fixture-user" : `fixture-app-${++grants}`,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    }
    const { query } = (await request.json()) as { query: string };
    if (query.includes("PawsBrowserIdentity"))
      return Response.json({
        data: {
          viewer: {
            id: "fixture-admin",
            app: false,
            name: "Example Admin",
            email: "admin@example.invalid",
            active: true,
            guest: false,
            admin: true,
            organization,
          },
        },
      });
    if (query.includes("PawsBrowserMembership"))
      return Response.json({
        data: {
          viewer,
          user: {
            id: "fixture-admin",
            active: true,
            guest: false,
            admin: true,
            organization,
            teams: { nodes: [{ id: "fixture-team" }], pageInfo: { hasNextPage: false } },
          },
        },
      });
    if (query.includes("PawsBrowserInstallation") || query.includes("PawsReconnect"))
      return Response.json({ data: { viewer } });
    if (query.includes("teams"))
      return Response.json({
        data: {
          viewer,
          teams: {
            nodes: [{ id: "fixture-team", name: "Engineering", key: "ENG" }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    return Response.json({
      data: {
        viewer,
        agentSessions: { nodes: [], pageInfo: { hasNextPage: false } },
        issues: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    });
  },
});
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "api.linear.app")
    return nativeFetch(`http://127.0.0.1:${provider.port}${url.pathname}`, init);
  if (["localhost", "127.0.0.1"].includes(url.hostname)) return nativeFetch(input, init);
  throw new Error(`Hosted network forbidden: ${url.hostname}`);
}) as typeof fetch;
const source = {
  PAWS_HOME: join(root, "home"),
  PAWS_PORT: String(port),
  PAWS_HOST: "127.0.0.1",
  PAWS_PUBLIC_DASHBOARD: "1",
  PAWS_PUBLIC_URL: origin,
  PAWS_TLS_KEY_PATH: key,
  PAWS_TLS_CERT_PATH: cert,
  LINEAR_CLIENT_ID: "fixture-linear-client",
  LINEAR_CLIENT_SECRET: "fixture-client-secret",
  LINEAR_WEBHOOKS: "false",
  GITHUB_AUTH: "app",
  GITHUB_APP_ID: "123",
  PAWS_GITHUB_CLIENT_ID: "Iv1.fixture",
  PAWS_GITHUB_CLIENT_SECRET: "fixture-github-secret",
  GITHUB_APP_PRIVATE_KEY_PATH: key,
};
const paws = startPaws(source, { noTunnel: true });
await paws.ready;
writeFileSync(instancePath, JSON.stringify({ origin, home: source.PAWS_HOME, pid: process.pid }));
console.log(JSON.stringify({ origin, home: source.PAWS_HOME }));
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  await paws.stop();
  await provider.stop(true);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGUSR1", () => {
  const scope = {
    organizationId: organization.id,
    oauthClientId: source.LINEAR_CLIENT_ID,
    appUserId: viewer.id,
  };
  recordLinearInstallation(paws.db, {
    ...scope,
    sessionId: "fixture-session",
    teamId: "fixture-team",
    observedAtMs: Date.now() - 2,
  });
  revokeLinearInstallation(paws.db, {
    ...scope,
    eventKey: `fixture-revoked-${Date.now()}`,
    createdAtMs: Date.now() - 1,
  });
});
