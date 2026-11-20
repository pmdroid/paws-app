import { workspaceMemberSteps, workspaceMemberUsable, type Db } from "../db";
import type { AgentIssue, AgentIssueRow, AgentTeam, TrackerAdapter } from "../linear";
import type { SlackToolProvider } from "./tools";

type Linear = Required<
  Pick<
    TrackerAdapter,
    | "searchAgentIssues"
    | "readAgentIssue"
    | "listAgentTeams"
    | "listAgentProjects"
    | "listAgentLabels"
    | "listAgentStates"
  >
>;
type Args = Record<string, unknown>;

const METHODS = [
  "searchAgentIssues",
  "readAgentIssue",
  "listAgentTeams",
  "listAgentProjects",
  "listAgentLabels",
  "listAgentStates",
] as const satisfies readonly (keyof Linear)[];

export const SLACK_LINEAR_ANSWER_BYTES = 16_384;
export const SLACK_LINEAR_NO_TEAMS = "You have no Linear teams Paws can read here.";
export const SLACK_LINEAR_NO_ISSUE = "No such issue.";
export const SLACK_LINEAR_CUT = "(cut; narrow the search)";
export const SLACK_LINEAR_INSTRUCTIONS = [
  "",
  "Linear tools: search_issues, get_issue, list_teams, list_projects, list_labels and list_states look up Linear in the asking person's teams that this conversation may show.",
  "They only read: nothing in Linear changes through them.",
].join("\n");

const string = { type: "string" };
const schema = (properties: Record<string, { type: string }>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const list = (name: string, what: string) => ({
  name,
  description: `List the ${what} of the asking person's Linear teams. Read only.`,
  inputSchema: schema({}),
});

const DEFINITIONS = [
  {
    name: "search_issues",
    description: "Search Linear issues by text or identifier in the asking person's teams.",
    inputSchema: schema({ query: string, limit: { type: "integer" } }, ["query"]),
  },
  {
    name: "get_issue",
    description: "Read one Linear issue by identifier or id, with relations and recent comments.",
    inputSchema: schema({ id: string }, ["id"]),
  },
  list("list_teams", "teams"),
  list("list_projects", "projects"),
  list("list_labels", "labels"),
  list("list_states", "workflow states"),
];

export function slackLinearTools(options: {
  store: Db;
  tracker: () => TrackerAdapter | null | undefined;
}): SlackToolProvider {
  return (run) => {
    const linear = options.tracker();
    if (!usable(linear)) return null;
    const read = new Set<string>();
    const direct = run.thread.channelId.startsWith("D");
    const readable = async (): Promise<AgentTeam[]> => {
      const member = await options.store.run((q) =>
        workspaceMemberSteps(q, run.workspaceId, run.member.userId),
      );
      const teamIds = workspaceMemberUsable(member) ? [...member.teamIds] : [];
      if (!teamIds.length) return [];
      const teams = await linear.listAgentTeams({ teamIds });
      return teams.filter((team) => teamIds.includes(team.id) && (direct || !team.private));
    };
    const calls: Record<string, (teams: AgentTeam[], args: Args) => Promise<string | string[]>> = {
      search_issues: async (teams, args) => {
        const rows = await linear.searchAgentIssues({
          teamIds: teams.map((team) => team.id),
          query: text(args["query"]),
          ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
        });
        rows.forEach((row) => note(teams, row.teamKey));
        return rows.length ? rows.map(issueLine).join("\n") : "No issues found.";
      },
      get_issue: async (teams, args) => {
        const issue = await linear.readAgentIssue({
          teamIds: teams.map((team) => team.id),
          id: text(args["id"]),
        });
        if (!issue) return SLACK_LINEAR_NO_ISSUE;
        note(teams, issue.teamKey);
        return issueText(issue);
      },
      list_teams: async (teams) => {
        teams.forEach((team) => read.add(team.id));
        return teams.map((team) => `${team.key} ${team.name}${team.private ? " (private)" : ""}`);
      },
      list_projects: async (teams) => {
        const projects = await linear.listAgentProjects({ teamIds: teams.map((team) => team.id) });
        projects.forEach((project) => note(teams, project.teamKey));
        return projects.map((project) => `${project.name} (${project.teamKey ?? "several teams"})`);
      },
      list_labels: async (teams) => {
        const labels = await linear.listAgentLabels({ teamIds: teams.map((team) => team.id) });
        labels.forEach((label) => note(teams, label.teamKey));
        return labels.map((label) => `${label.teamKey} ${label.name}`);
      },
      list_states: async (teams) => {
        const states = await linear.listAgentStates({ teamIds: teams.map((team) => team.id) });
        states.forEach((state) => note(teams, state.teamKey));
        return states.map((state) => `${state.teamKey} ${state.name} (${state.type})`);
      },
    };
    const note = (teams: AgentTeam[], key: string | null) => {
      for (const team of teams) if (key === null || team.key === key) read.add(team.id);
    };
    return {
      definitions: DEFINITIONS,
      instructions: SLACK_LINEAR_INSTRUCTIONS,
      linearTeamIds: () => [...read],
      async call(name, args) {
        const handle = calls[name];
        if (!handle) return { text: `Unknown tool ${name}.`, isError: true };
        const teams = await readable();
        if (!teams.length) return { text: SLACK_LINEAR_NO_TEAMS };
        const answer = await handle(teams, args);
        return { text: fit(Array.isArray(answer) ? answer.join("\n") || "None." : answer) };
      },
    };
  };
}

function usable(tracker: TrackerAdapter | null | undefined): tracker is TrackerAdapter & Linear {
  return !!tracker && METHODS.every((key) => typeof tracker[key] === "function");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function issueLine(row: AgentIssueRow): string {
  const people = [
    row.assignee ? `assignee ${row.assignee}` : "unassigned",
    ...(row.delegate ? [`delegate ${row.delegate}`] : []),
  ];
  const state = row.state ? ` [${row.state.name}]` : "";
  return `${row.identifier}${state} ${row.title} (${people.join(", ")}; updated ${row.updatedAt})${row.url ? ` ${row.url}` : ""}`;
}

function issueText(issue: AgentIssue): string {
  return [
    issueLine(issue),
    ...(issue.project ? [`Project: ${issue.project}`] : []),
    ...(issue.parent ? [`Parent: ${issue.parent}`] : []),
    ...(issue.labels.length ? [`Labels: ${issue.labels.join(", ")}`] : []),
    ...issue.relations.map(
      (relation) =>
        `Relation: ${relation.direction === "incoming" ? `${relation.identifier} ${relation.type} this` : `${relation.type} ${relation.identifier}`}`,
    ),
    "",
    issue.description || "(no description)",
    ...issue.comments.flatMap((comment) => [
      "",
      `Comment by ${comment.author ?? "someone"} at ${comment.createdAt}:`,
      comment.body,
    ]),
  ].join("\n");
}

function fit(answer: string): string {
  if (Buffer.byteLength(answer) <= SLACK_LINEAR_ANSWER_BYTES) return answer;
  const kept: string[] = [];
  let size = Buffer.byteLength(SLACK_LINEAR_CUT);
  for (const line of answer.split("\n")) {
    size += Buffer.byteLength(line) + 1;
    if (size > SLACK_LINEAR_ANSWER_BYTES) break;
    kept.push(line);
  }
  return [...kept, SLACK_LINEAR_CUT].join("\n");
}
