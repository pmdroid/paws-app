import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, putWorkspaceUser, syncWorkspaceMember } from "../../src/db";
import { createRunnerPlacementBrowser } from "../../src/runner-placement";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";
import { seed } from "../dialects";
import { tempStore } from "../pglite";

const root = process.argv[2];
if (!root) throw new Error("Provide a disposable evidence directory");
mkdirSync(root, { recursive: true });
const { db, close } = await tempStore();
const now = Date.now();
const owner = await putWorkspaceUser(db, {
  id: workspaceId(),
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
const token = await issueWorkspaceBootstrap(db, "org", now);
const workspace = await consumeWorkspaceBootstrap(db, {
  id: workspaceId(),
  organizationId: "org",
  name: "Test",
  userId: owner,
  tokenHash: workspaceTokenHash(token),
  now,
});
const member = await putWorkspaceUser(db, {
  id: workspaceId(),
  linearUserId: "member",
  name: "Member",
  email: "member@example.invalid",
});
await syncWorkspaceMember(db, {
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
for (const runner of runners)
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: runner.id,
        workspaceId: workspace.id,
        ownerUserId: runner.ownerUserId,
        name: runner.name,
        status: "active",
        createdAt: now,
        lastSeenAt: now,
      }),
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId: runner.id }),
    (q) =>
      q.orm.insert(q.t.runnerAgentPolicy).values({
        runnerId: runner.id,
        agent: "claude",
        ready: 1,
        quotaState: "exhausted",
        resetsAt: now + 3600000,
        cooldownUntil: now + 3600000,
      }),
    (q) =>
      q.orm.insert(q.t.runnerExecutionUsage).values({
        commandId: workspaceId(),
        runnerId: runner.id,
        ownerUserId: runner.ownerUserId,
        agent: "claude",
        model: "fixture-model",
        resolvedModel: "fixture-model",
        role: "implementer",
        purpose: "work",
        startedAt: now - 60000,
        endedAt: now - 1000,
        outcome: "quota_exhausted",
      }),
  );
const browser = createRunnerPlacementBrowser({ store: db });
const built = await Bun.build({
  entrypoints: [new URL("../../src/dashboard/src/client/runners.ts", import.meta.url).pathname],
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
      role: identity === "member" ? "member" : "admin",
      authenticatedAt: now,
      teamIds: ["team"],
    };
    if (path === "/runner.js")
      return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (path === "/style.css") {
      const assets = new URL("../../src/dashboard/dist/assets/", import.meta.url).pathname;
      const css = [...new Bun.Glob("*.css").scanSync(assets)][0];
      if (!css) return new Response("Run bun run build:dashboard first", { status: 503 });
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
  await close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
