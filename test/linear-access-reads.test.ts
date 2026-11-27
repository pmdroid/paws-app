import { expect, test } from "bun:test";
import {
  createLinearAccessReads,
  LinearForeignInstallationError,
  type LinearClient,
} from "../src/linear";

const viewer = { id: "app", app: true, organization: { id: "org" } };
const session = {
  id: "session",
  appUser: viewer,
  issue: { id: "issue", team: { id: "team" } },
};
function reads(data: unknown, clientId: string | null = "client") {
  const calls: { query: string; variables?: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const client: LinearClient = {
    async query(query, variables, options) {
      calls.push({ query, variables, signal: options?.signal });
      return data;
    },
  };
  return { adapter: createLinearAccessReads(client, clientId), calls };
}

test("authoritative session access binds the credential, app user, organization and issue team", async () => {
  const f = reads({ viewer, agentSession: session });
  const controller = new AbortController();
  expect(await f.adapter.session("session", { signal: controller.signal })).toEqual({
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    issueId: "issue",
    teamId: "team",
  });
  expect(f.calls[0]?.variables).toEqual({ id: "session" });
  expect(f.calls[0]?.signal).toBe(controller.signal);
  expect(f.calls[0]?.query).toContain("appUser { id app organization { id } }");
});

test.each([
  { viewer: { ...viewer, app: false }, agentSession: session },
  { viewer: { ...viewer, organization: null }, agentSession: session },
  { viewer, agentSession: { ...session, id: "other" } },
  { viewer, agentSession: { ...session, appUser: { ...viewer, id: "other" } } },
  { viewer, agentSession: { ...session, appUser: { ...viewer, app: false } } },
  {
    viewer,
    agentSession: { ...session, appUser: { ...viewer, organization: { id: "other" } } },
  },
  { viewer, agentSession: { ...session, issue: { id: "issue", team: null } } },
  { viewer, agentSession: null },
])("unverified or mismatched installation cannot authorize a session: %j", async (data) => {
  await expect(reads(data).adapter.session("session")).rejects.toThrow();
});

test.each([
  { viewer, agentSession: { ...session, id: "other" } },
  { viewer, agentSession: { ...session, appUser: { ...viewer, id: "other" } } },
  { viewer, agentSession: { ...session, appUser: { ...viewer, app: false } } },
  {
    viewer,
    agentSession: { ...session, appUser: { ...viewer, organization: { id: "other" } } },
  },
])("a session of another installation is a positive mismatch: %j", async (data) => {
  const failure = await reads(data)
    .adapter.session("session")
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LinearForeignInstallationError);
  expect((failure as LinearForeignInstallationError).sessionId).toBe("session");
});

test.each([
  { viewer, agentSession: { ...session, id: null } },
  { viewer, agentSession: { ...session, appUser: null } },
  { viewer, agentSession: { ...session, appUser: { ...viewer, id: "other", app: null } } },
  { viewer, agentSession: { ...session, appUser: { ...viewer, organization: null } } },
  { viewer, agentSession: { ...session, id: "other", appUser: { ...viewer, organization: {} } } },
  { viewer: { ...viewer, organization: null }, agentSession: { ...session, id: "other" } },
  { viewer, agentSession: null },
])("an unreadable session field is not a positive mismatch: %j", async (data) => {
  const failure = await reads(data)
    .adapter.session("session")
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(LinearForeignInstallationError);
});

test("a missing OAuth client cannot establish installation ownership", async () => {
  await expect(reads({ viewer }, null).adapter.installation()).rejects.toThrow("OAuth client");
});

test("team access distinguishes explicit denial from malformed or mismatched reads", async () => {
  expect(await reads({ team: { id: "team" } }).adapter.team("team")).toBe(true);
  expect(await reads({ team: null }).adapter.team("team")).toBe(false);
  await expect(reads({ team: { id: "other" } }).adapter.team("team")).rejects.toThrow();
  await expect(reads({}).adapter.team("team")).rejects.toThrow();
});

test("Stop during a completed access read rejects its stale result", async () => {
  const controller = new AbortController();
  const adapter = createLinearAccessReads(
    {
      async query() {
        controller.abort(new Error("Stopped"));
        return { viewer, agentSession: session };
      },
    },
    "client",
  );
  await expect(adapter.session("session", { signal: controller.signal })).rejects.toThrow(
    "Stopped",
  );
});

test("repository team choices paginate within the installed Linear organization", async () => {
  let index = 0;
  const adapter = createLinearAccessReads(
    {
      async query(query) {
        if (!query.includes("PawsRepositoryTeams")) return { viewer };
        return {
          viewer,
          teams: {
            nodes: [{ id: `team${index}`, name: `Team ${index}`, key: `T${index}` }],
            pageInfo: { hasNextPage: index++ === 0, endCursor: "next" },
          },
        };
      },
    },
    "client",
  );
  expect(await adapter.teams!()).toEqual([
    { id: "team0", name: "Team 0", key: "T0" },
    { id: "team1", name: "Team 1", key: "T1" },
  ]);
  const wrong = createLinearAccessReads(
    {
      async query(query) {
        return query.includes("PawsRepositoryTeams")
          ? {
              viewer: { ...viewer, organization: { id: "other" } },
              teams: { nodes: [], pageInfo: { hasNextPage: false } },
            }
          : { viewer };
      },
    },
    "client",
  );
  await expect(wrong.teams!()).rejects.toThrow("installation changed");
});
