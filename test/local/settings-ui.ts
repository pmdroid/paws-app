import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDatabase } from "../../src/db";
import { INSTALLATION_PERMISSIONS } from "../../src/github";
import { startServer } from "../../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  type WorkspaceAccess,
} from "../../src/workspace";

const root = process.env.PAWS_VERIFY_ROOT;
if (root === undefined) throw new Error("Use scripts/verify-local.ts workspace-serve.");
const db = openDatabase(join(root, "workspace-ui.sqlite"));
migrate(db);
const home = join(root, "home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const key = join(home, "fixture.key");
const cert = join(home, "fixture.crt");
const generated = Bun.spawnSync([
  "openssl",
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "1",
  "-keyout",
  key,
  "-out",
  cert,
  "-subj",
  "/CN=127.0.0.1",
  "-addext",
  "subjectAltName=IP:127.0.0.1",
]);
if (generated.exitCode !== 0) throw new Error("Could not create the disposable HTTPS identity.");
let installed = false;
let unavailable = false;
let hiddenRepository: string | null = null;
let permissionsReady = false;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture" && request.method === "POST") {
      const body = (await request.json()) as {
        installed?: boolean;
        unavailable?: boolean;
        expire?: boolean;
        disconnect?: boolean;
        hiddenRepository?: string | null;
        permissionsReady?: boolean;
      };
      if (body.installed !== undefined) installed = body.installed;
      if (body.unavailable !== undefined) unavailable = body.unavailable;
      if (body.hiddenRepository !== undefined) hiddenRepository = body.hiddenRepository;
      if (body.permissionsReady !== undefined) permissionsReady = body.permissionsReady;
      if (body.disconnect) db.run("DELETE FROM workspace_github_connection");
      if (body.expire)
        db.run("UPDATE workspace_session SET authenticated_at=?", [
          Date.now() - 2 * 24 * 60 * 60_000,
        ]);
      return Response.json({ ok: true });
    }
    if (unavailable) return Response.json({ error: "Synthetic GitHub outage" }, { status: 503 });
    if (url.pathname === "/user/installations")
      return Response.json({
        total_count: installed ? 2 : 0,
        installations: installed
          ? [
              {
                id: 23,
                app_id: 99,
                account: { login: "other" },
                permissions: INSTALLATION_PERMISSIONS,
              },
              {
                id: 22,
                app_id: 99,
                account: { login: "acme" },
                permissions: permissionsReady
                  ? INSTALLATION_PERMISSIONS
                  : { contents: "write", actions: "read", metadata: "read" },
              },
            ]
          : [],
      });
    if (url.pathname === "/user/installations/23/repositories")
      return Response.json({
        total_count: 1,
        repositories: [{ id: 100, full_name: "other/readme", permissions: { admin: true } }],
      });
    if (url.pathname === "/user/installations/22/repositories")
      return Response.json({
        total_count: hiddenRepository ? 25 : 26,
        repositories: Array.from({ length: 26 }, (_, index) => ({
          id: index + 1,
          full_name: index === 0 ? "acme/widgets" : "acme/service-" + index,
          private: true,
          permissions: { admin: true },
        })).filter((repo) => repo.full_name !== hiddenRepository),
      });
    if (url.pathname === "/app")
      return Response.json({ id: 99, client_id: "Iv1.fixture", slug: "fixture-paws" });
    if (/^\/repos\/acme\/(widgets|service-[0-9]+)\/installation$/.test(url.pathname))
      return Response.json(
        { id: 22, app_id: 99, suspended_at: null, permissions: INSTALLATION_PERMISSIONS },
        { status: installed ? 200 : 404 },
      );
    if (url.pathname === "/app/installations/22/access_tokens") {
      const body = (await request.json()) as {
        repositories: string[];
        permissions: Record<string, string>;
      };
      return Response.json(
        {
          token: "synthetic-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          repository_selection: "selected",
          repositories: body.repositories.map((name) => ({ name, full_name: "acme/" + name })),
          permissions: body.permissions,
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/login/oauth/access_token")
      return Response.json({ access_token: "ghu_syntheticidentity", scope: "" });
    if (url.pathname === "/user")
      return Response.json({ id: 7, login: "fixture-human", type: "User", name: "Fixture Human" });
    if (/^\/repos\/acme\/(widgets|service-[0-9]+)$/.test(url.pathname))
      return Response.json({ permissions: { admin: true }, owner: { type: "User", id: 7 } });
    throw new Error("Unexpected fixture GitHub request");
  },
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  if (["https://api.github.com", "https://github.com"].includes(url.origin))
    return nativeFetch(`http://127.0.0.1:${provider.port}${url.pathname}${url.search}`, init);
  if (url.hostname !== "127.0.0.1")
    throw new Error("Hosted requests are blocked by the Settings fixture.");
  return nativeFetch(input, init);
}) as typeof fetch;
const ready = Promise.withResolvers<WorkspaceAccess>();
const server = startServer({
  hostname: "127.0.0.1",
  port: 0,
  db,
  webhooks: false,
  tls: { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") },
  statusEnv: {
    PAWS_HOME: home,
    GITHUB_AUTH: "app",
    GITHUB_APP_ID: "99",
    PAWS_GITHUB_CLIENT_ID: "Iv1.fixture",
    PAWS_GITHUB_CLIENT_SECRET: "synthetic-client-secret",
    GITHUB_APP_PRIVATE_KEY_PATH: key,
  },
  workspaceAccess: ready.promise,
  agentSettings: {
    configPath: join(root, "config.toml"),
  },
});
const origin = `https://127.0.0.1:${server.port}`;
ready.resolve(
  createWorkspaceAccess({
    db,
    githubAttributionClient: {
      clientId: "Iv1.fixture",
      clientSecret: "synthetic-client-secret",
    },
    publicUrl: origin,
    clientId: "fixture-client",
    installedOrganization: { id: "fixture-org", name: "Paws verification" },
    memberships: {
      async installation() {
        return { id: "fixture-org", name: "Paws verification" };
      },
      async member(organizationId, userId) {
        return {
          organizationId,
          userId,
          active: true,
          guest: false,
          admin: false,
          teamIds: ["fixture-team"],
        };
      },
    },
    verifyTeam: async (id) => ["fixture-team", "fixture-quality"].includes(id),
    readTeams: async () => [
      { id: "fixture-team", name: "Engineering", key: "ENG" },
      { id: "fixture-quality", name: "Quality", key: "QA" },
    ],
    slackIdentities: {
      teamId: "T123",
      async lookup(email) {
        return email.startsWith("owner@") ? "U123" : null;
      },
    },
    fetch: (async (input, init) => {
      if (["https://github.com", "https://api.github.com"].includes(new URL(String(input)).origin))
        return globalThis.fetch(input, init);
      if (String(input) === "https://api.linear.app/oauth/token")
        return Response.json({
          access_token: `fixture-${new URLSearchParams(String(init?.body)).get("code")}`,
        });
      if (String(input) !== "https://api.linear.app/graphql")
        throw new Error("Unexpected hosted request");
      const user = new Headers(init?.headers).get("authorization")?.endsWith("owner")
        ? "owner"
        : "member";
      return Response.json({
        data: {
          viewer: {
            id: user,
            name: user === "owner" ? "Fixture owner" : "Fixture member",
            email: `${user}@example.invalid`,
            app: false,
            organization: { id: "fixture-org", name: "Paws verification" },
          },
        },
      });
    }) as typeof fetch,
  }),
);
writeFileSync(
  join(root, "workspace-ui.json"),
  JSON.stringify({
    origin,
    control: `http://127.0.0.1:${provider.port}/__fixture`,
    bootstrap: issueWorkspaceBootstrap(db, "fixture-org"),
  }),
);
console.log(`Workspace browser fixture: ${origin}/status/`);
const stopped = Promise.withResolvers<void>();
const stop = () => stopped.resolve();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const deadline = setTimeout(stop, 5 * 60_000);
await stopped.promise;
clearTimeout(deadline);
await server.stop(true);
await provider.stop(true);
writeFileSync(
  join(root, "workspace-ui-audit.json"),
  JSON.stringify(db.query("SELECT * FROM workspace_access_audit").all(), null, 2),
);
db.close();
