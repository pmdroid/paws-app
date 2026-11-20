import {
  agentIssueId,
  agentSearchLimit,
  checkAgentIssueCreate,
  checkAgentIssueUpdate,
  AGENT_ISSUE_LIMITS,
  cutAgentIssue,
  type AgentIssue,
  type AgentIssueRef,
  type AgentIssueRow,
  type AgentTeamScope,
  type AgentLabel,
  type AgentProject,
  type AgentState,
  type AgentTeam,
  type createLinearAgentIssueMethods,
} from "./agent-issues";

const ROW = "id identifier title url state teamKey assignee delegate updatedAt".split(" ");

const matches = (issue: AgentIssue, term: string) =>
  [issue.title, issue.identifier, issue.description].join("\n").toLowerCase().includes(term);

const LIST = AGENT_ISSUE_LIMITS.list;

type Methods = ReturnType<typeof createLinearAgentIssueMethods>;
type Owned<T> = T & { teamIds: string[] };

export type FakeAgentIssues = Methods & {
  agentIssues: Owned<AgentIssue>[];
  agentTeams: AgentTeam[];
  agentProjects: Owned<AgentProject>[];
  agentLabels: Owned<AgentLabel>[];
  agentStates: Owned<AgentState>[];
  agentIssueCalls: { operation: keyof Methods; input: unknown }[];
  agentIssuesByKey: Map<string, Owned<AgentIssue>>;
  agentAppUser: string;
};

export function createFakeAgentIssues(): FakeAgentIssues {
  const fake: Omit<FakeAgentIssues, keyof Methods> = {
    ...{ agentIssues: [], agentTeams: [], agentProjects: [], agentLabels: [], agentStates: [] },
    agentIssueCalls: [],
    agentIssuesByKey: new Map(),
    agentAppUser: "Paws",
  };
  const visible = <T>(operation: keyof Methods, input: AgentTeamScope, items: Owned<T>[]) => {
    fake.agentIssueCalls.push({ operation, input: structuredClone(input) });
    return items
      .filter((item) => item.teamIds.some((id) => input.teamIds.includes(id)))
      .map(({ teamIds: _, ...item }) => structuredClone(item) as T);
  };
  const row = (issue: AgentIssue) =>
    Object.fromEntries(ROW.map((key) => [key, issue[key as keyof AgentIssue]])) as AgentIssueRow;
  const ref = ({ id, identifier, url }: AgentIssue): AgentIssueRef => ({ id, identifier, url });
  const owner = (operation: keyof Methods, input: AgentTeamScope & { id: string }) => {
    fake.agentIssueCalls.push({ operation, input: structuredClone(input) });
    const id = input.id.trim().toUpperCase();
    return fake.agentIssues.find(
      (issue) =>
        issue.teamIds.some((team) => input.teamIds.includes(team)) &&
        (issue.id.toUpperCase() === id || issue.identifier.toUpperCase() === id),
    );
  };
  const named = <T extends { id: string; name: string }>(items: T[], id: string) =>
    items.find((item) => item.id === id)?.name ?? id;
  const teams = () => fake.agentTeams.map((team) => ({ ...team, teamIds: [team.id] }));
  const methods: Methods = {
    async searchAgentIssues(search) {
      const term = search.query.trim().toLowerCase();
      return visible("searchAgentIssues", search, fake.agentIssues)
        .filter((issue) => matches(issue, term))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, agentSearchLimit(search.limit))
        .map(row);
    },
    async readAgentIssue(read) {
      const id = read.id.trim().toUpperCase();
      const issue = visible("readAgentIssue", read, fake.agentIssues).find(
        (entry) => entry.id.toUpperCase() === id || entry.identifier.toUpperCase() === id,
      );
      return issue ? cutAgentIssue(issue) : null;
    },
    listAgentTeams: async (scope) => visible("listAgentTeams", scope, teams()).slice(0, LIST),
    listAgentProjects: async (scope) =>
      visible("listAgentProjects", scope, fake.agentProjects).slice(0, LIST),
    listAgentLabels: async (scope) =>
      visible("listAgentLabels", scope, fake.agentLabels).slice(0, LIST),
    listAgentStates: async (scope) =>
      visible("listAgentStates", scope, fake.agentStates).slice(0, LIST),
    async createAgentIssue(request) {
      checkAgentIssueCreate(request);
      fake.agentIssueCalls.push({ operation: "createAgentIssue", input: structuredClone(request) });
      let issue = fake.agentIssuesByKey.get(request.key);
      if (issue && !issue.teamIds.includes(request.teamId))
        throw new Error("The agent issue exists in another team");
      if (!issue) {
        const team = fake.agentTeams.find((entry) => entry.id === request.teamId);
        const teamKey = team?.key ?? "FAKE";
        const identifier = `${teamKey}-${fake.agentIssues.length + 1}`;
        issue = {
          ...{ id: agentIssueId(request.key), identifier, title: request.title, teamKey },
          ...{ url: null, state: null, assignee: null, updatedAt: new Date(0).toISOString() },
          delegate: request.delegate ? fake.agentAppUser : null,
          description: request.description,
          project: request.projectId ? named(fake.agentProjects, request.projectId) : null,
          parent: request.parentId ?? null,
          labels: (request.labelIds ?? []).map((id) => named(fake.agentLabels, id)),
          ...{ relations: [], comments: [], teamIds: [request.teamId] },
        };
        fake.agentIssues.push(issue);
        fake.agentIssuesByKey.set(request.key, issue);
      }
      const relation = request.relation;
      if (relation) {
        const type = relation.type === "related" ? "related" : "blocks";
        const direction = relation.type === "blocked_by" ? "incoming" : "outgoing";
        const link = { type, identifier: relation.issueId, direction } as const;
        if (!issue.relations.some((entry) => JSON.stringify(entry) === JSON.stringify(link)))
          issue.relations.push(link);
      }
      return ref(issue);
    },
    async updateAgentIssue(request) {
      checkAgentIssueUpdate(request);
      const issue = owner("updateAgentIssue", request);
      if (!issue) return null;
      if (request.title !== undefined) issue.title = request.title;
      if (request.description !== undefined) issue.description = request.description;
      if (request.projectId !== undefined)
        issue.project = named(fake.agentProjects, request.projectId);
      if (request.labelIds)
        issue.labels = request.labelIds.map((id) => named(fake.agentLabels, id));
      const state = fake.agentStates.find((entry) => entry.id === request.stateId);
      if (state) issue.state = { name: state.name, type: state.type };
      return ref(issue);
    },
    async assignAgentIssue(read) {
      const issue = owner("assignAgentIssue", read);
      if (!issue) return null;
      issue.delegate = fake.agentAppUser;
      return ref(issue);
    },
  };
  return Object.assign(fake, methods);
}
