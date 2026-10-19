import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
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
const access = createWorkspaceAccess({
  db,
  assignments,
  publicUrl: configured,
  clientId: "client",
  installedOrganization: { id: "org", name: "Fixture" },
  memberships,
  fetch: (async (input, init) => {
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
    const headers = new Headers(request.headers);
    headers.set("host", new URL(configured).host);
    const internal = new Request(`${configured}${url.pathname}${url.search}`, {
      headers,
      method: request.method,
    });
    return (
      (await access.handle(internal)) ??
      (await handleStatusRequest(request, {})) ??
      new Response(null, { status: 404 })
    );
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
const deadline = setTimeout(() => stopped.resolve(), 60000);
await stopped.promise;
clearTimeout(deadline);
await server.stop(true);
await access.stop();
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
