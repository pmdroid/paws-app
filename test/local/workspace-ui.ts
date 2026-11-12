import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertQueuedItem, recordLinearInstallation } from "../../src/db";
import { createLinearMembershipReads } from "../../src/linear";
import { startServer } from "../../src/server";
import { createWorkspaceAccess, type WorkspaceAccess } from "../../src/workspace";
import { tempStore } from "../pglite";

const root = process.env.PAWS_VERIFY_ROOT;
if (root === undefined) throw new Error("Use scripts/verify-local.ts workspace-serve.");
const { db, close } = await tempStore();
await insertQueuedItem(db, {
  id: "fixture-item",
  sessionKey: "fixture-session",
  title: "Verify workspace access",
});
await recordLinearInstallation(db, {
  sessionId: "fixture-session",
  organizationId: "fixture-org",
  teamId: "fixture-team",
  oauthClientId: "fixture-client",
  appUserId: "fixture-app",
  observedAtMs: Date.now(),
});
const ready = Promise.withResolvers<WorkspaceAccess>();
const server = startServer({
  hostname: "127.0.0.1",
  port: 0,
  db,
  webhooks: false,
  statusEnv: {},
  workspaceAccess: ready.promise,
  agentSettings: {
    configPath: join(root, "config.toml"),
  },
});
const origin = `http://127.0.0.1:${server.port}`;
ready.resolve(
  createWorkspaceAccess({
    store: db,
    githubAttributionClient: {
      clientId: "fixture-github",
      clientSecret: "synthetic-browser-secret",
    },
    publicUrl: origin,
    clientId: "fixture-client",
    installedOrganization: { id: "fixture-org", name: "Paws verification" },
    memberships: createLinearMembershipReads({
      async query(_query, variables) {
        return {
          viewer: { app: true, organization: { id: "fixture-org", name: "Paws verification" } },
          user: {
            id: variables?.["id"],
            active: true,
            guest: false,
            admin: variables?.["id"] === "owner",
            organization: { id: "fixture-org" },
            teams: {
              nodes: [{ id: "fixture-team" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    }),
    verifyTeam: async (id) => id === "fixture-team",
    fetch: (async (input, init) => {
      if (String(input) === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "ghu_syntheticidentity", scope: "" });
      if (String(input) === "https://api.github.com/user")
        return Response.json({
          id: 1234,
          login: "fixture-human",
          type: "User",
          name: "Fixture Human",
        });
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
writeFileSync(join(root, "workspace-ui.json"), JSON.stringify({ origin }));
console.log(`Workspace browser fixture: ${origin}/dashboard/`);
const stopped = Promise.withResolvers<void>();
const stop = () => stopped.resolve();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const deadline = setTimeout(stop, 5 * 60_000);
await stopped.promise;
clearTimeout(deadline);
await server.stop(true);
writeFileSync(
  join(root, "workspace-ui-audit.json"),
  JSON.stringify(
    await db.run((q) => q.all(q.orm.select().from(q.t.workspaceAccessAudit))),
    null,
    2,
  ),
);
await close();
