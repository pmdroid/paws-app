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
import { tempStore } from "./pglite";

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
      thread: { teamId: "T0ONE", channelId, threadTs: "1.000001", installGeneration: 1 },
      requestId: "r1",
    });
  return { tracker, teams, tools };
}

test("searches and reads only the asker's teams, and another team's issue is no such issue", async () => {
  const { tracker, tools } = await setup();
  const made = tools()!;
  expect(made.definitions.map((tool) => tool.name)).toEqual([
    ...["search_issues", "get_issue", "list_teams"],
    ...["list_projects", "list_labels", "list_states"],
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

test("a channel leaves out private teams and a direct message includes them", async () => {
  const { tools } = await setup();
  const channel = tools("C0ONE")!;
  expect((await channel.call("search_issues", { query: "canary" })).text).not.toContain("SEC-1");
  expect((await channel.call("get_issue", { id: "SEC-1" })).text).toBe(SLACK_LINEAR_NO_ISSUE);
  expect((await channel.call("list_teams", {})).text).toBe("ENG Engineering");
  const direct = tools("D0ONE")!;
  expect((await direct.call("search_issues", { query: "canary" })).text).toContain("SEC-1");
  expect((await direct.call("list_teams", {})).text).toContain("SEC Security (private)");
  expect(direct.linearTeamIds!().sort()).toEqual(["eng", "sec"]);
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
