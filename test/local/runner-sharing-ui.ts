import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import { createRunnerPlacementBrowser } from "../../src/runner-placement";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

const root = process.argv[2];
if (!root) throw new Error("Provide a disposable evidence directory");
mkdirSync(root, { recursive: true });
const db = openDatabase(join(root, "ui.sqlite"));
migrate(db);
const now = Date.now();
const owner = putWorkspaceUser(db, {
  id: workspaceId(),
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
const token = issueWorkspaceBootstrap(db, "org", now);
const workspace = consumeWorkspaceBootstrap(db, {
  id: workspaceId(),
  organizationId: "org",
  name: "Test",
  userId: owner,
  tokenHash: workspaceTokenHash(token),
  now,
});
const member = putWorkspaceUser(db, {
  id: workspaceId(),
  linearUserId: "member",
  name: "Member",
  email: "member@example.invalid",
});
syncWorkspaceMember(db, {
  workspaceId: workspace.id,
  userId: member,
  role: "member",
  active: true,
  teamIds: ["team"],
  now,
});
const runners = [
  { id: workspaceId(), name: "Pascal’s Linux host", ownerUserId: owner, status: "active" },
  { id: workspaceId(), name: "Design team host", ownerUserId: member, status: "active" },
];
for (const runner of runners) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    [runner.id, workspace.id, runner.ownerUserId, runner.name, now, now],
  );
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runner.id]);
  db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,ready,quota_state,resets_at,cooldown_until) VALUES(?,'claude',1,'exhausted',?,?)",
    [runner.id, now + 3600000, now + 3600000],
  );
  db.run(
    "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,model,resolved_model,role,purpose,started_at,ended_at,outcome) VALUES(?,?,?,'claude','fixture-model','fixture-model','implementer','work',?,?,'quota_exhausted')",
    [workspaceId(), runner.id, runner.ownerUserId, now - 60000, now - 1000],
  );
}
const browser = createRunnerPlacementBrowser({ db });
const built = await Bun.build({
  entrypoints: [new URL("../../src/web/src/client/runners.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
});
if (!built.success) throw new Error("Browser build failed");
const script = await built.outputs[0]!.text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const identity = request.headers.get("cookie")?.includes("identity=member")
      ? "member"
      : "owner";
    const principal: WorkspacePrincipal = {
      workspaceId: workspace.id,
      userId: identity === "member" ? member : owner,
      role: identity === "member" ? "member" : "owner",
      authenticatedAt: now,
      teamIds: ["team"],
    };
    if (path === "/runner.js")
      return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (path === "/style.css") {
      const assets = new URL("../../src/web/dist/assets/", import.meta.url).pathname;
      const css = [...new Bun.Glob("*.css").scanSync(assets)][0];
      if (!css) return new Response("Run bun run build:status first", { status: 503 });
      return new Response(Bun.file(join(assets, css)), { headers: { "content-type": "text/css" } });
    }
    if (path === "/api/auth/session") return Response.json(principal);
    if (path === "/api/runners") return Response.json({ runners });
    if (path.endsWith("/health")) return Response.json({ lastSeenAt: now, checks: [] });
    if (path.startsWith("/api/")) {
      if (
        request.method === "POST" &&
        (request.headers.get("origin") !== new URL(request.url).origin ||
          request.headers.get("x-paws-csrf") !== "fixture-csrf")
      )
        return Response.json({ error: "CSRF token required." }, { status: 403 });
      return (await browser(request, principal)) ?? new Response(null, { status: 404 });
    }
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="paws-csrf" content="fixture-csrf"><link rel="stylesheet" href="/style.css"></head><body data-area="runners"><div class="main"><main class="content" id="runners"></main></div><script type="module">import{createRunners}from'/runner.js';createRunners().mount(document.querySelector('#runners'),location.origin,'live')</script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
writeFileSync(
  join(root, "fixture.json"),
  JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, runners, owner, member }, null, 2) +
    "\n",
);
console.log(`http://127.0.0.1:${server.port}`);
async function stop() {
  await server.stop(true);
  db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
