import { expect, test } from "bun:test";
import { createLinearAgentIssueMethods } from "./agent-issues";
import { createFakeTracker } from "./fake";

const ENG = { id: "team-eng", key: "ENG" };
const OPS = { id: "team-ops", key: "OPS" };
const UUID = "4f2b8c1e-0d3a-4b5c-9e6f-7a8b9c0d1e2f";
const state = { name: "Todo", type: "unstarted" };

const issue = (identifier: string, team: typeof ENG, updatedAt: string) => ({
  ...{ id: `${identifier}-id`, identifier, title: `Fix ${identifier}`, updatedAt, state, team },
  assignee: { name: "Ada" },
});

function client(data: Record<string, unknown>) {
  const variables: (Record<string, unknown> | undefined)[] = [];
  return {
    variables,
    query: async (_: string, input?: Record<string, unknown>) => (variables.push(input), data),
  };
}

test("search keeps only the given teams, newest update first, at most the limit", async () => {
  const nodes = [
    issue("ENG-1", ENG, "2026-01-01"),
    issue("OPS-9", OPS, "2026-03-01"),
    issue("ENG-2", ENG, "2026-02-01"),
    issue("ENG-3", ENG, "2026-01-15"),
  ];
  const linear = client({ issues: { nodes } });
  const methods = createLinearAgentIssueMethods(linear);
  const rows = await methods.searchAgentIssues({ teamIds: [ENG.id], query: "eng-2", limit: 2 });
  expect(rows.map((row) => row.identifier)).toEqual(["ENG-2", "ENG-3"]);
  expect(rows[0]).toMatchObject({ teamKey: "ENG", assignee: "Ada", delegate: null, state });
  const term = { containsIgnoreCase: "eng-2" };
  expect(linear.variables[0]).toEqual({
    first: 2,
    filter: {
      team: { id: { in: [ENG.id] } },
      or: [
        { title: term },
        { description: term },
        { team: { key: { eqIgnoreCase: "eng" } }, number: { eq: 2 } },
      ],
    },
  });
  await methods.searchAgentIssues({ teamIds: [ENG.id], query: "x", limit: 500 });
  await methods.searchAgentIssues({ teamIds: [ENG.id], query: "x" });
  expect(linear.variables.slice(1).map((input) => input?.["first"])).toEqual([25, 10]);
});

test("a read cuts long text, keeps the newest 20 comments and hides other teams and unknown issues", async () => {
  const comments = Array.from({ length: 25 }, (_, index) => ({
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}`,
    body: index === 24 ? "c".repeat(3_000) : `comment ${index}`,
    user: index === 24 ? null : { name: "Ada" },
    botActor: { name: "Bot" },
  }));
  const node = {
    ...issue("ENG-7", ENG, "2026-02-01"),
    id: UUID,
    description: "d".repeat(9_000),
    labels: { nodes: [{ name: "bug" }] },
    project: { name: "Paws" },
    parent: { identifier: "ENG-1" },
    relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-8" } }] },
    inverseRelations: { nodes: [{ type: "related", issue: { identifier: "ENG-6" } }] },
    comments: { nodes: comments },
  };
  const linear = client({ issues: { nodes: [node] } });
  const methods = createLinearAgentIssueMethods(linear);
  const read = await methods.readAgentIssue({ teamIds: [ENG.id], id: "eng-7" });
  expect(read?.description).toHaveLength(8_000);
  expect(read?.comments).toHaveLength(20);
  const newest = { author: "Bot", createdAt: "2026-01-25", body: "c".repeat(2_000) };
  expect(read?.comments[0]).toEqual(newest);
  expect(read?.comments.at(-1)?.body).toBe("comment 5");
  expect(read).toMatchObject({ labels: ["bug"], project: "Paws", parent: "ENG-1" });
  expect(read?.relations).toEqual([
    { type: "blocks", identifier: "ENG-8", direction: "outgoing" },
    { type: "related", identifier: "ENG-6", direction: "incoming" },
  ]);
  expect(linear.variables[0]).toEqual({
    filter: { team: { id: { in: [ENG.id] }, key: { eqIgnoreCase: "eng" } }, number: { eq: 7 } },
  });
  expect(await methods.readAgentIssue({ teamIds: [ENG.id], id: UUID })).not.toBeNull();
  expect(await methods.readAgentIssue({ teamIds: [OPS.id], id: UUID })).toBeNull();
  expect(await methods.readAgentIssue({ teamIds: [ENG.id], id: "ENG-99" })).toBeNull();
});

test("lists keep only objects of the given teams", async () => {
  const teams = [ENG, OPS].map((team) => ({ ...team, name: team.key, private: false }));
  const projects = [[ENG], [ENG, OPS], [OPS]].map((owners, index) => ({
    ...{ id: `p${index}`, name: `P${index}`, teams: { nodes: owners } },
  }));
  const labels = [ENG, null].map((team, index) => ({ id: `l${index}`, name: "bug", team }));
  const states = [ENG, OPS].map((team, index) => ({ id: `s${index}`, ...state, team }));
  const linear = client({
    teams: { nodes: teams },
    projects: { nodes: projects },
    issueLabels: { nodes: labels },
    workflowStates: { nodes: states },
  });
  const methods = createLinearAgentIssueMethods(linear);
  const scope = { teamIds: [ENG.id] };
  expect(await methods.listAgentTeams(scope)).toEqual([teams[0]!]);
  expect(await methods.listAgentProjects(scope)).toEqual([
    { id: "p0", name: "P0", teamKey: "ENG" },
    { id: "p1", name: "P1", teamKey: null },
  ]);
  expect(await methods.listAgentLabels(scope)).toEqual([{ id: "l0", name: "bug", teamKey: "ENG" }]);
  expect(await methods.listAgentStates(scope)).toEqual([{ id: "s0", ...state, teamKey: "ENG" }]);
  expect(linear.variables).toEqual(Array(4).fill({ ids: [ENG.id] }));
});

test("every operation with no teams returns nothing without calling Linear", async () => {
  const linear = client({});
  const methods = createLinearAgentIssueMethods(linear);
  const none = { teamIds: [] };
  expect(await methods.searchAgentIssues({ ...none, query: "x" })).toEqual([]);
  expect(await methods.readAgentIssue({ ...none, id: "ENG-1" })).toBeNull();
  const { listAgentTeams, listAgentProjects, listAgentLabels, listAgentStates } = methods;
  for (const list of [listAgentTeams, listAgentProjects, listAgentLabels, listAgentStates])
    expect(await list(none)).toEqual([]);
  expect(linear.variables).toEqual([]);
});

test("the fake tracker records each call and applies the team rule to its issues", async () => {
  const tracker = createFakeTracker();
  const empty = { url: null, state: null, assignee: null, delegate: null, project: null };
  const lists = { labels: [], relations: [], comments: [], parent: null };
  const stored = (identifier: string, team: typeof ENG, updatedAt: string) => ({
    ...{ ...empty, ...lists, id: `${identifier}-id`, identifier, title: "Retry", updatedAt },
    ...{ teamKey: team.key, description: "x".repeat(9_000), teamIds: [team.id] },
  });
  tracker.agentIssues.push(
    stored("ENG-1", ENG, "2026-01-01"),
    stored("ENG-2", ENG, "2026-02-01"),
    stored("OPS-1", OPS, "2026-03-01"),
  );
  const rows = await tracker.searchAgentIssues({ teamIds: [ENG.id], query: "retry" });
  expect(rows.map((row) => row.identifier)).toEqual(["ENG-2", "ENG-1"]);
  expect(rows[0]).not.toHaveProperty("description");
  const read = await tracker.readAgentIssue({ teamIds: [ENG.id], id: "eng-1" });
  expect(read?.description).toHaveLength(8_000);
  expect(await tracker.readAgentIssue({ teamIds: [ENG.id], id: "OPS-1" })).toBeNull();
  const operations = tracker.agentIssueCalls.map((call) => call.operation);
  expect(operations).toEqual(["searchAgentIssues", "readAgentIssue", "readAgentIssue"]);
});
