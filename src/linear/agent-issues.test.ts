import { expect, test } from "bun:test";
import { agentIssueId, createLinearAgentIssueMethods } from "./agent-issues";
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

function linearWrites() {
  const issues: Record<string, unknown>[] = [];
  const sent: { text: string; variables: Record<string, unknown> }[] = [];
  const query = async (text: string, variables: Record<string, unknown> = {}) => {
    sent.push({ text, variables });
    const input = variables["input"] as Record<string, unknown>;
    if (text.includes("AgentIssueExisting") || text.includes("AgentIssueTarget"))
      return { viewer: { id: "paws-app" }, issues: { nodes: issues } };
    if (text.includes("issueCreate")) {
      const team = { id: input["teamId"] };
      const created = { id: input["id"], identifier: "ENG-5", url: null, team };
      issues.push({ ...created, relations: { nodes: [] }, inverseRelations: { nodes: [] } });
      return { issueCreate: { success: true, issue: created } };
    }
    if (text.includes("issueRelationCreate")) {
      const link = { type: input["type"], issue: { id: input["issueId"], identifier: "ENG-1" } };
      (issues[0]!["inverseRelations"] as { nodes: unknown[] }).nodes.push(link);
      return { issueRelationCreate: { success: true } };
    }
    return { issueUpdate: { success: true, issue: issues[0] } };
  };
  const mutations = () => sent.filter((entry) => entry.text.startsWith("mutation"));
  return { issues, sent, mutations, methods: createLinearAgentIssueMethods({ query }) };
}

test("an agent issue is created once per key, delegated to Paws, with one relation", async () => {
  const linear = linearWrites();
  const relation = { issueId: "ENG-1", type: "blocked_by" } as const;
  const request = { key: "k1", teamId: ENG.id, title: "Retry", description: "Scope" };
  const created = { ...request, labelIds: ["l1"], relation, delegate: true };
  const first = await linear.methods.createAgentIssue(created);
  expect(await linear.methods.createAgentIssue(created)).toEqual(first);
  const id = agentIssueId("k1");
  expect(first).toEqual({ id, identifier: "ENG-5", url: null });
  expect(linear.mutations().map((entry) => entry.variables["input"])).toEqual([
    {
      id,
      teamId: ENG.id,
      title: "Retry",
      description: "Scope",
      delegateId: "paws-app",
      labelIds: ["l1"],
    },
    { issueId: "ENG-1", relatedIssueId: id, type: "blocks" },
  ]);
  await expect(linear.methods.createAgentIssue({ ...created, teamId: OPS.id })).rejects.toThrow(
    "another team",
  );
});

test("updating or assigning an issue outside the teams changes nothing", async () => {
  const linear = linearWrites();
  linear.issues.push({ id: UUID, identifier: "ENG-5", url: null, team: ENG });
  const { updateAgentIssue, assignAgentIssue } = linear.methods;
  expect(await updateAgentIssue({ teamIds: [], id: UUID, title: "New" })).toBeNull();
  expect(await assignAgentIssue({ teamIds: [], id: UUID })).toBeNull();
  expect(linear.sent).toEqual([]);
  expect(await updateAgentIssue({ teamIds: [OPS.id], id: UUID, title: "New" })).toBeNull();
  expect(await assignAgentIssue({ teamIds: [OPS.id], id: "eng-5" })).toBeNull();
  expect(linear.mutations()).toEqual([]);
  const ref = { id: UUID, identifier: "ENG-5", url: null };
  expect(
    await updateAgentIssue({ teamIds: [ENG.id], id: UUID, priority: 2, title: "New" }),
  ).toEqual(ref);
  expect(await assignAgentIssue({ teamIds: [ENG.id], id: "ENG-5" })).toEqual(ref);
  expect(linear.mutations().map((entry) => entry.variables)).toEqual([
    { id: UUID, input: { title: "New", priority: 2 } },
    { id: UUID, input: { delegateId: "paws-app" } },
  ]);
});

test("writes over a limit throw before any request", async () => {
  const linear = linearWrites();
  const request = { key: "k1", teamId: ENG.id, title: "Retry", description: "", delegate: false };
  const { createAgentIssue, updateAgentIssue } = linear.methods;
  await expect(createAgentIssue({ ...request, title: "t".repeat(257) })).rejects.toThrow("256");
  await expect(createAgentIssue({ ...request, description: "d".repeat(20_001) })).rejects.toThrow();
  await expect(createAgentIssue({ ...request, labelIds: Array(11).fill("l") })).rejects.toThrow();
  const scope = { teamIds: [ENG.id], id: UUID };
  await expect(updateAgentIssue({ ...scope, title: "t".repeat(257) })).rejects.toThrow();
  await expect(updateAgentIssue({ ...scope, description: "d".repeat(20_001) })).rejects.toThrow();
  expect(linear.sent).toEqual([]);
});

test("the fake tracker keeps created issues per key and applies the team rule to writes", async () => {
  const tracker = createFakeTracker();
  tracker.agentTeams.push({ ...ENG, name: "Engineering", private: false });
  const relation = { issueId: "ENG-9", type: "related" } as const;
  const request = { key: "k1", teamId: ENG.id, title: "Retry", description: "", relation };
  const first = await tracker.createAgentIssue({ ...request, delegate: true });
  expect(await tracker.createAgentIssue({ ...request, delegate: true })).toEqual(first);
  expect(tracker.agentIssues).toHaveLength(1);
  expect(tracker.agentIssues[0]).toMatchObject({ identifier: "ENG-1", delegate: "Paws" });
  expect(tracker.agentIssues[0]!.relations).toHaveLength(1);
  expect(
    await tracker.updateAgentIssue({ teamIds: [OPS.id], id: first.id, title: "X" }),
  ).toBeNull();
  expect(await tracker.assignAgentIssue({ teamIds: [OPS.id], id: "ENG-1" })).toBeNull();
  await tracker.updateAgentIssue({ teamIds: [ENG.id], id: "eng-1", title: "Renamed" });
  expect(tracker.agentIssues[0]!.title).toBe("Renamed");
  const operations = tracker.agentIssueCalls.map((call) =>
    call.operation.replace("AgentIssue", ""),
  );
  expect(operations).toEqual(["create", "create", "update", "assign", "update"]);
});
