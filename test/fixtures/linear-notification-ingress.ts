import "../quiet-journal";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindLinearSessionTask,
  getLinearSessionContext,
  migrate,
  openDatabase,
  recordLinearInstallation,
  requireLinearTaskDelegation,
  setJournalSink,
} from "../../src/db";
import { startPaws } from "../../src/index";
import { intakeDelegatedIssue } from "../../src/intake";
import {
  createFakeTracker,
  createInboxStore,
  linearTokenPath,
  writeStoredToken,
} from "../../src/linear";

setJournalSink((line) => {
  if (
    line.startsWith("catch ") &&
    (line.includes("operation=poller.") || line.includes("operation=webhook."))
  )
    console.error(line);
});

const home = process.argv[2]!;
const mode = process.argv[3] ?? "notification";
const contextMode = mode === "context" || mode === "github-auth";
let githubReads = 0;
if (mode === "github-auth") {
  writeFileSync(
    join(home, "config.toml"),
    '[tracker]\nkind = "linear"\n[github]\nauth = "app"\nrepo = "acme/app"\n',
  );
}
let teamReads = 0;
let contextReads = 0;
const db = openDatabase(join(home, "paws.db"));
migrate(db);
const task = await intakeDelegatedIssue(
  db,
  createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: [],
    },
  ]),
  { linearIssueId: "issue" },
);
if (!task.ok) throw new Error("Unexpected cycle");
const itemId = task.items[0]!.id;
db.run("UPDATE work_item SET state = 'awaiting_input' WHERE id = ?", [itemId]);
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
bindLinearSessionTask(db, "session", task.delegation.id, { actorId: "human" });
requireLinearTaskDelegation(db, {
  itemId,
  issueId: "issue",
  teamId: "team",
  appUserId: "app",
  humanActorId: "human",
});
db.close();
writeStoredToken(linearTokenPath(join(home, "secrets")), {
  accessToken: "fake-access",
  refreshToken: "fake-refresh",
  expiresAtMs: Date.now() + 600_000,
  actor: "app",
  scope: "read,write",
});
const nativeFetch = fetch;
const queries: string[] = [];
globalThis.fetch = Object.assign(
  async (_url: unknown, init?: RequestInit) => {
    const url = new URL(String(_url));
    if (url.hostname === "api.github.com") {
      githubReads++;
      if (url.pathname === "/user")
        return Response.json(
          { id: 7, login: "owner" },
          { headers: { "x-oauth-scopes": "repo, read:org" } },
        );
      if (url.pathname === "/repos/acme/app")
        return Response.json({ permissions: { push: true, pull: true } });
      if (url.pathname === "/search/issues") return Response.json({ items: [] });
      if (url.pathname.endsWith("/issues") || url.pathname.endsWith("/issues/comments"))
        return Response.json([]);
      throw new Error("Unexpected offline GitHub request");
    }
    const query = JSON.parse(String(init?.body)).query as string;
    if (query.includes("IntakePoll")) return Response.json({ data: { viewer: { id: "app" } } });
    queries.push(query);
    if (query.includes("PawsIssueContext")) {
      contextReads++;
      if (contextMode && contextReads === 1) throw new Error("Temporary context read failure");
      const after = JSON.parse(String(init?.body)).variables.after;
      return Response.json({
        data: {
          issue: {
            id: "issue",
            team: { id: "team" },
            identifier: "ENG-1",
            title: "Updated issue",
            description: "Updated description",
            state: { type: "started" },
            reactions: [{ id: "issue-reaction", emoji: "thumbsup" }],
            comments: {
              nodes: [
                {
                  id: after ? "second-comment" : "first-comment",
                  body: after ? "Latest user detail" : "Original comment",
                  reactions: [{ id: "comment-reaction", emoji: "eyes" }],
                },
              ],
              pageInfo: {
                hasNextPage: after === null,
                endCursor: after === null ? "second-page" : null,
              },
            },
          },
        },
      });
    }
    if (query.includes("PawsSessionInstallation"))
      return Response.json({
        data: {
          viewer: { id: "app", app: true, organization: { id: "org" } },
          agentSession: {
            id: "session",
            appUser: { id: "app", app: true, organization: { id: "org" } },
            issue: { id: "issue", team: { id: "team" } },
          },
        },
      });
    if (query.includes("IssueOwnership"))
      return Response.json({
        data: {
          issue: {
            id: "issue",
            team: { id: "team" },
            state: { type: "started" },
            assignee: { id: "another-human" },
            delegate: mode === "notification" ? null : { id: "app" },
          },
        },
      });
    if (query.includes("PawsTeamAccess")) {
      teamReads++;
      if (mode === "retry" && teamReads === 1) throw new Error("Temporary offline permission read");
      return Response.json({ data: { team: mode === "denied" ? null : { id: "team" } } });
    }
    if (query.includes("agentActivityCreate"))
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "ack" } } },
      });
    throw new Error("Unexpected offline request");
  },
  { preconnect: () => undefined },
);
const paws = startPaws(
  {
    HOME: home,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    LINEAR_MODE: "agent-session",
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "fake-secret",
    LINEAR_WEBHOOKS: "true",
    LINEAR_WEBHOOK_SECRET: "fake-webhook-secret",
  },
  { noTunnel: true },
);
const statuses: number[] = [];
const deliveries = contextMode
  ? ["first", "retry", "duplicate"]
  : mode === "notification"
    ? ["first", "duplicate"]
    : mode === "retry"
      ? ["permission", "permission"]
      : ["permission"];
const createdAt = new Date().toISOString();
for (const delivery of deliveries) {
  const event = {
    ...scope,
    type: "AppUserNotification",
    action: contextMode ? "issueNewComment" : "issueUnassignedFromYou",
    createdAt,
    webhookTimestamp: Date.now(),
    notification: {
      id: "notification",
      type: contextMode ? "issueNewComment" : "issueUnassignedFromYou",
      userId: "app",
      issueId: "issue",
      issue: { id: "issue", teamId: "team" },
    },
  };
  const body = JSON.stringify(
    mode === "notification" || contextMode
      ? event
      : {
          ...scope,
          createdAt,
          webhookTimestamp: Date.now(),
          type: "PermissionChange",
          action: "teamAccessChanged",
          canAccessAllPublicTeams: false,
          addedTeamIds: [],
          removedTeamIds: [],
        },
  );
  statuses.push(
    (
      await nativeFetch(new URL("/webhooks/linear", paws.server.url), {
        method: "POST",
        headers: {
          "linear-delivery": delivery,
          "linear-signature": createHmac("sha256", "fake-webhook-secret")
            .update(body)
            .digest("hex"),
        },
        body,
      })
    ).status,
  );
  for (
    let attempt = 0;
    createInboxStore(paws.db).listUnhandled().length > 0 && attempt < 100;
    attempt++
  )
    await Bun.sleep(5);
}
const state = paws.db
  .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id = ?")
  .get(itemId)?.state;
await paws.catchUp();
const pending = createInboxStore(paws.db).listUnhandled().length;
const context = getLinearSessionContext(paws.db, "session");
await paws.stop();
const reopened = openDatabase(join(home, "paws.db"));
const restoredContext = getLinearSessionContext(reopened, "session");
reopened.close();
console.log(
  JSON.stringify({
    statuses,
    ...(mode === "github-auth" ? { githubReads } : {}),
    state,
    pending,
    ...(contextMode ? { contextReads, context, restoredContext } : {}),
    sessionReads: queries.filter((query) => query.includes("PawsSessionInstallation")).length,
    workflowMutations: queries.filter((query) => query.includes("issueUpdate")).length,
    ...(mode === "notification" ? {} : { teamReads }),
  }),
);
