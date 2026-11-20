import { afterAll, expect, test } from "bun:test";
import { putWorkspaceUserSteps, syncWorkspaceMemberSteps, type Db } from "../src/db";
import { createFakeTracker, type AgentIssue, type TrackerAdapter } from "../src/linear";
import {
  slackLinearTools,
  SLACK_LINEAR_CUT,
  SLACK_LINEAR_NO_ISSUE,
  SLACK_LINEAR_NO_TEAMS,
} from "../src/slack";
import { withoutForeignKeys } from "./pglite-fixtures";
import { sqlRows, tempStore } from "./pglite";

const stores: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(stores.map((store) => store.close())));

const issue = (identifier: string, team: string, description = "") =>
  ({
    ...{ id: `id-${identifier}`, identifier, title: `canary ${identifier}`, url: null },
    ...{ state: { name: "Todo", type: "unstarted" }, teamKey: identifier.split("-")[0]! },
    ...{ assignee: null, delegate: null, updatedAt: "2026-11-20T00:00:00.000Z", project: null },
    ...{ parent: null, description, labels: [], relations: [], comments: [], teamIds: [team] },
  }) as AgentIssue & { teamIds: string[] };

async function setup() {
  const handle = await tempStore();
  stores.push(handle);
  const db: Db = handle.db;
  await withoutForeignKeys(db);
  await db.run((q) =>
    putWorkspaceUserSteps(q, { id: "um", linearUserId: "l-um", name: "M", email: "m@x" }),
  );
  let now = 0;
  const teams = (teamIds: string[]) =>
    db.run((q) =>
      syncWorkspaceMemberSteps(q, {
        ...{ workspaceId: "W1", userId: "um", role: "member", active: true },
        ...{ teamIds, now: ++now },
      }),
    );
  await teams(["eng", "sec"]);
  const tracker = createFakeTracker();
  tracker.agentTeams.push(
    { id: "eng", key: "ENG", name: "Engineering", private: false },
    { id: "sec", key: "SEC", name: "Security", private: true },
    { id: "ops", key: "OPS", name: "Operations", private: false },
  );
  tracker.agentIssues.push(issue("ENG-1", "eng"), issue("SEC-1", "sec"), issue("OPS-1", "ops"));
  const tools = (channelId = "C0ONE", linear: TrackerAdapter | null = tracker) =>
    slackLinearTools({ store: db, tracker: () => linear })({
      workspaceId: "W1",
      member: { userId: "um", linkId: "link" },
      slackUserId: "SMEMBER",
      mentionTs: "1.000002",
      thread: { teamId: "T0ONE", channelId, threadTs: "1.000001", installGeneration: 1 },
      requestId: "r1",
    });
  return { db, tracker, teams, tools };
}

test("searches and reads only the asker's teams, and another team's issue is no such issue", async () => {
  const { tracker, tools } = await setup();
  const made = tools()!;
  expect(made.definitions.map((tool) => tool.name)).toEqual([
    ...["search_issues", "get_issue", "list_teams"],
    ...["list_projects", "list_labels", "list_states"],
    ...["create_issue", "update_issue", "assign_issue"],
  ]);
  expect(made.instructions).toContain("nothing in Linear changes");
  const found = await made.call("search_issues", { query: "canary", teamIds: ["ops"] });
  expect(found.text).toContain("ENG-1 [Todo] canary ENG-1");
  expect(found.text).not.toContain("OPS-1");
  expect((await made.call("get_issue", { id: "OPS-1" })).text).toBe(SLACK_LINEAR_NO_ISSUE);
  expect((await made.call("get_issue", { id: "ENG-404" })).text).toBe(SLACK_LINEAR_NO_ISSUE);
  expect((await made.call("get_issue", { id: "eng-1" })).text).toStartWith("ENG-1 [Todo]");
  expect(made.linearTeamIds!()).toEqual(["eng"]);
  const writes = tracker.agentIssueCalls.filter(
    (call) => !/^(search|read|list)/.test(call.operation),
  );
  expect(writes).toEqual([]);
});

test("private teams are left out", async () => {
  const { tools } = await setup();
  const channel = tools("C0ONE")!;
  expect((await channel.call("search_issues", { query: "canary" })).text).not.toContain("SEC-1");
  expect((await channel.call("get_issue", { id: "SEC-1" })).text).toBe(SLACK_LINEAR_NO_ISSUE);
  expect((await channel.call("list_teams", {})).text).toBe("ENG Engineering");
  expect(channel.linearTeamIds!()).toEqual(["eng"]);
});

test("teams are read at each call, and with none left nothing is called", async () => {
  const { tracker, teams, tools } = await setup();
  const made = tools()!;
  expect((await made.call("get_issue", { id: "ENG-1" })).text).toStartWith("ENG-1");
  await teams(["ops"]);
  expect((await made.call("get_issue", { id: "ENG-1" })).text).toBe(SLACK_LINEAR_NO_ISSUE);
  await teams(["sec"]);
  const calls = tracker.agentIssueCalls.length;
  for (const name of ["search_issues", "get_issue", "list_labels"])
    expect((await made.call(name, { query: "x", id: "SEC-1" })).text).toBe(SLACK_LINEAR_NO_TEAMS);
  expect(tracker.agentIssueCalls.slice(calls).map((call) => call.operation)).toEqual(
    Array(3).fill("listAgentTeams"),
  );
});

test("a long answer is cut at a line end with the marker", async () => {
  const { tracker, tools } = await setup();
  const long = issue("ENG-2", "eng");
  const body = Array(60).fill("x".repeat(30)).join("\n");
  long.comments = Array.from({ length: 20 }, (_, n) => ({
    ...{ author: "Ann", createdAt: `2026-11-${String(n + 1).padStart(2, "0")}`, body },
  }));
  tracker.agentIssues.push(long);
  const { text } = await tools()!.call("get_issue", { id: "ENG-2" });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16_384);
  expect(Buffer.byteLength(text)).toBeGreaterThan(16_000);
  expect(text.endsWith(`\n${"x".repeat(30)}\n${SLACK_LINEAR_CUT}`)).toBe(true);
});

test("without the tracker operations there are no tools", async () => {
  const { tools } = await setup();
  expect(tools("C0ONE", null)).toBeNull();
  expect(tools("C0ONE", { ...createFakeTracker(), readAgentIssue: undefined })).toBeNull();
});

test("create, update and assign only store proposals for the asker's teams, at most three per run", async () => {
  const { db, tracker, tools } = await setup();
  tracker.agentLabels.push({ id: "l-bug", name: "Bug", teamKey: "ENG", teamIds: ["eng"] });
  tracker.agentStates.push(
    ...[{ id: "s-done", name: "Done", type: "completed", teamKey: "ENG", teamIds: ["eng"] }],
  );
  const made = tools()!;
  const proposed = "Proposed. <@SMEMBER> has to confirm it in Slack.";
  const refused = async (name: string, args: Record<string, unknown>, text: string) =>
    expect(await made.call(name, args as never)).toEqual({ text, isError: true });
  const create = { team: "eng", title: "Retry", description: "Retry uploads." };
  await refused("create_issue", { ...create, team: "OPS" }, "Name one of these Linear teams: ENG.");
  await refused("create_issue", { ...create, team: "SEC" }, "Name one of these Linear teams: ENG.");
  await refused("create_issue", { ...create, labels: ["Nope"] }, 'No label named "Nope" in ENG.');
  await refused("update_issue", { id: "OPS-1", title: "x" }, "No such issue. (OPS-1)");
  await refused("assign_issue", { id: "SEC-1" }, "No such issue. (SEC-1)");
  await refused("update_issue", { id: "ENG-1" }, "Name at least one field to change.");
  expect(await made.call("create_issue", { ...create, labels: ["bug"], parent: "ENG-1" })).toEqual({
    text: proposed,
  });
  expect(await made.call("update_issue", { id: "ENG-1", state: "done" })).toEqual({
    text: proposed,
  });
  expect(await made.call("assign_issue", { id: "ENG-1" })).toEqual({ text: proposed });
  await refused("assign_issue", { id: "ENG-1" }, "This run has proposed 3 changes already.");
  const writes = tracker.agentIssueCalls.filter((call) => !/^(read|list)/.test(call.operation));
  expect(writes).toEqual([]);
  const rows = await sqlRows<{ value: string }>(
    db,
    "SELECT value FROM setting WHERE key LIKE 'slack.draft:W1:T0ONE:C0ONE:1.000001:%'",
  );
  const changes = rows
    .map((row) => JSON.parse(row.value).change)
    .sort((a, b) => a.kind.localeCompare(b.kind));
  expect(changes).toEqual([
    { kind: "assign", run: "r1", shown: [], issueId: "id-ENG-1", identifier: "ENG-1" },
    {
      ...{ kind: "create", run: "r1", description: "Retry uploads.", start: true },
      ...{ shown: ["Labels: bug", "Parent: ENG-1"], labelIds: ["l-bug"], parentId: "id-ENG-1" },
    },
    {
      ...{ kind: "update", run: "r1", shown: ["State: Done"], issueId: "id-ENG-1" },
      ...{ identifier: "ENG-1", fields: { stateId: "s-done" } },
    },
  ]);
});
