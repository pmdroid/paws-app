import {
  agentSearchLimit,
  AGENT_ISSUE_LIMITS,
  cutAgentIssue,
  type AgentIssue,
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
};

export function createFakeAgentIssues(): FakeAgentIssues {
  const fake: Omit<FakeAgentIssues, keyof Methods> = {
    ...{ agentIssues: [], agentTeams: [], agentProjects: [], agentLabels: [], agentStates: [] },
    agentIssueCalls: [],
  };
  const visible = <T>(operation: keyof Methods, input: AgentTeamScope, items: Owned<T>[]) => {
    fake.agentIssueCalls.push({ operation, input: structuredClone(input) });
    return items
      .filter((item) => item.teamIds.some((id) => input.teamIds.includes(id)))
      .map(({ teamIds: _, ...item }) => structuredClone(item) as T);
  };
  const row = (issue: AgentIssue) =>
    Object.fromEntries(ROW.map((key) => [key, issue[key as keyof AgentIssue]])) as AgentIssueRow;
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
  };
  return Object.assign(fake, methods);
}
