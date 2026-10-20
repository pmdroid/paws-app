import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createRunnerLogin } from "../../src/runner-login";
import { createRunnerWork } from "../../src/runner-work";
import { join, resolve } from "node:path";
import {
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  workspaceLinearMember,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import {
  createWorkspaceAccess,
  createWorkspaceAssignments,
  issueWorkspaceBootstrap,
  workspaceTokenHash,
} from "../../src/workspace";
import { handleStatusRequest } from "../../src/web";

const root = resolve(process.argv[2]!);
mkdirSync(root, { recursive: true, mode: 0o700 });
if (
  !realpathSync(process.env.HOME!).startsWith(root + "/") ||
  !realpathSync(process.env.KYOTOAGENT_ROOT!).startsWith(root + "/")
)
  throw new Error("Use a disposable HOME and KYOTOAGENT_ROOT inside the proof directory.");
const db = openDatabase(join(root, "paws.sqlite"));
migrate(db);
const now = Date.now();
const ownerId = putWorkspaceUser(db, {
  id: "owner",
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
consumeWorkspaceBootstrap(db, {
  id: "workspace",
  organizationId: "org",
  name: "Fixture",
  tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
  userId: ownerId,
  now,
});
const spec = {
  linearIssueId: "issue",
  identifier: "PAS-339",
  title: "Continue setting up your delegated issue",
  description: "Fixture",
  subIssues: [],
};
const installation = {
  sessionId: "session",
  organizationId: "org",
  oauthClientId: "client",
  appUserId: "app",
  teamId: "team",
  observedAtMs: now,
};
ensureLinearSession(db, { sessionId: "session", issueId: "issue", creatorId: "member" });
recordLinearInstallation(db, installation);
const token = "a".repeat(43);
db.run("INSERT INTO workspace_assignment VALUES(?,?,?,?,?,?,?,?,?)", [
  "session",
  0,
  "workspace",
  "member",
  workspaceTokenHash(token),
  JSON.stringify({ installation, spec }),
  "{}",
  now + 600000,
  "pending",
]);
const memberships = {
  async installation() {
    return { id: "org", name: "Fixture" };
  },
  async member(organizationId: string, userId: string) {
    return { organizationId, userId, active: true, guest: false, admin: false, teamIds: ["team"] };
  },
};
const configured = "https://paws.example.invalid";
const assignments = createWorkspaceAssignments({
  onboarding: {},
  db,
  origin: configured,
  clientId: "client",
  memberships,
  tracker: createFakeTracker([spec]),
  lifecycle: {
    async inspect() {
      throw new Error("No execution");
    },
    async startCodeIssue() {
      throw new Error("No execution");
    },
  },
  async accept() {
    return false;
  },
  async continue() {
    throw new Error("No execution");
  },
});
const login = createRunnerLogin({
  db,
  work: createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  }),
});
const health = new Set<string>();
const access = createWorkspaceAccess({
  onboardingAgents: () => ({
    login,
    health: {
      agents: (_principal, runnerId) =>
        (["claude", "codex"] as const).map((agent) => ({
          agent,
          status: health.has(`${runnerId}/${agent}`)
            ? ("signed_in" as const)
            : ("unknown" as const),
          checkedAt: Date.now(),
        })),
    },
  }),
  db,
  assignments,
  memberGitHub: {
    secretsDir: join(root, "secrets"),
    client: { clientId: "fixture-github", clientSecret: "fixture-secret" },
  },
  publicUrl: configured,
  clientId: "client",
  installedOrganization: { id: "org", name: "Fixture" },
  memberships,
  fetch: (async (input, init) => {
    if (String(input) === "https://github.com/login/oauth/access_token")
      return Response.json({ access_token: "ghu_fixture", scope: "", token_type: "bearer" });
    if (String(input) === "https://api.github.com/user")
      return Response.json({ id: 123, login: "fixture-member", type: "User" });
    if (String(input).endsWith("/oauth/token"))
      return Response.json({
        access_token: `fixture-${new URLSearchParams(String(init?.body)).get("code")}`,
      });
    if (String(input) !== "https://api.linear.app/graphql") throw new Error("Unexpected provider");
    const id = new Headers(init?.headers).get("authorization")!.replace("Bearer fixture-", "");
    return Response.json({
      data: {
        viewer: {
          id,
          name: id,
          email: `${id}@example.invalid`,
          app: false,
          organization: { id: "org", name: "Fixture" },
        },
      },
    });
  }) as typeof fetch,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__vm-fixture" && request.method === "POST") {
      const member = workspaceLinearMember(db, "workspace", "member")!;
      const ids = ["01AAAAAAAAAAAAAAAAAAAAAAAA", "01BBBBBBBBBBBBBBBBBBBBBBBB"];
      if (url.searchParams.get("mode") === "remove")
        db.run("UPDATE runner SET status='paused' WHERE id=?", [ids[0]!]);
      else
        for (const [index, id] of ids.entries()) {
          db.run(
            "INSERT OR IGNORE INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
            [id, "workspace", member.userId, `Member VM ${index + 1}`, now],
          );
          db.run(
            "INSERT OR IGNORE INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until) VALUES(?,?,?,?,?,?,?)",
            [id, id, id, "synthetic", now - 1, now + 600000, now + 600000],
          );
        }
      if (url.searchParams.get("mode") !== "remove") {
        db.run("UPDATE runner SET status='active'");
        db.run("DELETE FROM onboarding_vm");
        db.run("DELETE FROM runner_member_account");
        db.run("DELETE FROM runner_login");
        health.clear();
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__agent-fixture" && request.method === "POST") {
      const mode = url.searchParams.get("mode") ?? "waiting";
      for (const row of db
        .query<{ id: string; runnerId: string; agent: string }, []>(
          "SELECT id,runner_id AS runnerId,agent FROM runner_login WHERE state IN ('starting','waiting')",
        )
        .all()) {
        if (mode === "expired") {
          db.run("UPDATE runner_login SET expires_at=? WHERE id=?", [Date.now() - 1, row.id]);
          continue;
        }
        login.exchange(row.runnerId, row.id, {
          state: mode === "connected" ? "connected" : mode === "failed" ? "failed" : "waiting",
          terminal: mode === "waiting" && row.agent === "claude" ? "PRIVATE CLAUDE CHALLENGE" : "",
          authorization:
            mode === "waiting" && row.agent === "codex"
              ? {
                  url: "https://auth.openai.com/codex/device",
                  message: "PRIVATE DEVICE CODE ABCD-1234",
                }
              : null,
          inputId: mode === "waiting" ? randomUUID() : null,
        });
        if (mode === "connected") health.add(`${row.runnerId}/${row.agent}`);
      }
      return Response.json({ ok: true });
    }
    const headers = new Headers(request.headers);
    headers.set("host", new URL(configured).host);
    if (headers.has("origin")) headers.set("origin", configured);
    const internal = new Request(`${configured}${url.pathname}${url.search}`, {
      headers,
      method: request.method,
      ...(request.method === "POST" || request.method === "DELETE"
        ? { body: await request.text() }
        : {}),
    });
    const response =
      (await access.handle(internal)) ??
      (await handleStatusRequest(request, {})) ??
      new Response(null, { status: 404 });
    const location = response.headers.get("location");
    if (location?.startsWith(configured)) {
      const redirected = new Headers(response.headers);
      redirected.set("location", location.replace(configured, url.origin));
      return new Response(response.body, { status: response.status, headers: redirected });
    }
    return response;
  },
});
console.log(
  JSON.stringify({
    origin: server.url.origin,
    assignment: `/auth/linear?assignment=${token}`,
    page: "/status/onboarding/session/0",
  }),
);
const stopped = Promise.withResolvers<void>();
process.on("SIGTERM", () => stopped.resolve());
process.on("SIGINT", () => stopped.resolve());
const deadline = setTimeout(() => stopped.resolve(), 180000);
await stopped.promise;
clearTimeout(deadline);
await server.stop(true);
await access.stop();
login.stop();
writeFileSync(
  join(root, "onboarding-audit.json"),
  JSON.stringify(
    {
      assignments: db.query("SELECT session_id,generation,status FROM workspace_assignment").all(),
      progress: db.query("SELECT payload FROM outbox").all(),
    },
    null,
    2,
  ),
);
db.close();
