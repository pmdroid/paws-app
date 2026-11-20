import { workspaceMemberSteps, workspaceMemberUsable, type Db } from "../db";
import type { SlackToolProvider, SlackToolRun } from "./tools";
import * as work from "./work";

type Scope = { teamIds: readonly string[] };
type AgentTeam = { id: string; key: string; name: string; private: boolean };
type AgentIssueRow = Record<"id" | "identifier" | "title" | "teamKey" | "updatedAt", string> &
  Record<"url" | "assignee" | "delegate", string | null> & {
    state: { name: string; type: string } | null;
  };
type AgentIssue = AgentIssueRow &
  Record<"project" | "parent", string | null> & {
    description: string;
    labels: string[];
    relations: { type: string; identifier: string; direction: "outgoing" | "incoming" }[];
    comments: { author: string | null; createdAt: string; body: string }[];
  };
type Linear = {
  searchAgentIssues(search: Scope & { query: string; limit?: number }): Promise<AgentIssueRow[]>;
  readAgentIssue(read: Scope & { id: string }): Promise<AgentIssue | null>;
  listAgentTeams(scope: Scope): Promise<AgentTeam[]>;
  listAgentProjects(scope: Scope): Promise<{ id: string; name: string; teamKey: string | null }[]>;
  listAgentLabels(scope: Scope): Promise<{ id: string; name: string; teamKey: string }[]>;
  listAgentStates(
    scope: Scope,
  ): Promise<{ id: string; name: string; type: string; teamKey: string }[]>;
};
type SlackLinearReader = { [K in keyof Linear]?: Linear[K] | undefined };
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
  `create_issue, update_issue and assign_issue only propose a change, at most ${work.SLACK_PROPOSALS} per answer: nothing changes in Linear until the asking person confirms it in Slack, so say it is proposed, not done.`,
].join("\n");

const string = { type: "string" };
const strings = { type: "array", items: string };
const schema = (
  properties: Record<string, { type: string; items?: { type: string } }>,
  required: string[] = [],
) => ({
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
  {
    name: "create_issue",
    description:
      "Propose a new Linear issue in one of the asking person's teams (team key). Names of the project and labels must exist in that team. start (default true) delegates it to Paws. Nothing changes until the person confirms.",
    inputSchema: schema(
      {
        ...{ team: string, title: string, description: string, project: string },
        ...{ labels: strings, parent: string, related_to: string, start: { type: "boolean" } },
      },
      ["team", "title", "description"],
    ),
  },
  {
    name: "update_issue",
    description:
      "Propose changes to a Linear issue in the asking person's teams; state, labels and project are names. Nothing changes until the person confirms.",
    inputSchema: schema(
      {
        id: string,
        title: string,
        description: string,
        state: string,
        labels: strings,
        project: string,
      },
      ["id"],
    ),
  },
  {
    name: "assign_issue",
    description:
      "Propose delegating a Linear issue in the asking person's teams to Paws. Nothing changes until the person confirms.",
    inputSchema: schema({ id: string }, ["id"]),
  },
];

class Refused extends Error {}

export function slackLinearTools(options: {
  store: Db;
  tracker: () => SlackLinearReader | null | undefined;
  now?: () => number;
}): SlackToolProvider {
  const now = options.now ?? Date.now;
  return (run) => {
    const linear = options.tracker();
    if (!usable(linear)) return null;
    const read = new Set<string>();
    const readable = async (): Promise<AgentTeam[]> => {
      const member = await options.store.run((q) =>
        workspaceMemberSteps(q, run.workspaceId, run.member.userId),
      );
      const teamIds = workspaceMemberUsable(member) ? [...member.teamIds] : [];
      if (!teamIds.length) return [];
      const teams = await linear.listAgentTeams({ teamIds });
      return teams.filter((team) => teamIds.includes(team.id) && !team.private);
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
        return teams.map((team) => `${team.key} ${team.name}`);
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
    let proposed = 0;
    const propose = (teams: AgentTeam[], args: Args, kind: "create" | "update" | "assign") =>
      proposal(linear, run, teams, args, kind).then(async (draft) => {
        read.add(draft.team.id);
        if (!work.draftMessage(draft, draft.team, draft.id))
          throw new Refused("That change is too long to show in Slack; shorten it.");
        await options.store.transaction((q) => work.proposeChangeSteps(q, draft, now()));
        return work.proposedText(run.slackUserId);
      });
    calls["create_issue"] = (teams, args) => propose(teams, args, "create");
    calls["update_issue"] = (teams, args) => propose(teams, args, "update");
    calls["assign_issue"] = (teams, args) => propose(teams, args, "assign");
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
        const proposing = name.endsWith("_issue") && name !== "get_issue";
        if (proposing && proposed >= work.SLACK_PROPOSALS)
          return { text: work.WORK_NOTICES.proposals, isError: true };
        if (proposing) proposed++;
        try {
          const answer = await handle(teams, args);
          return { text: fit(Array.isArray(answer) ? answer.join("\n") || "None." : answer) };
        } catch (error) {
          if (proposing) proposed--;
          if (error instanceof Refused) return { text: error.message, isError: true };
          throw error;
        }
      },
    };
  };
}

async function proposal(
  linear: Linear,
  run: SlackToolRun,
  teams: AgentTeam[],
  args: Args,
  kind: "create" | "update" | "assign",
): Promise<Omit<work.Draft, "slot" | "createdAt">> {
  const teamIds = teams.map((team) => team.id);
  const issueOf = async (id: string) => {
    const found = id ? await linear.readAgentIssue({ teamIds, id }) : null;
    if (!found) throw new Refused(`${SLACK_LINEAR_NO_ISSUE} (${id || "no id"})`);
    return found;
  };
  const target = kind === "create" ? null : await issueOf(text(args["id"]));
  const key = target?.teamKey ?? text(args["team"]);
  const team = teams.find((entry) => entry.key.toUpperCase() === key.toUpperCase());
  if (!team)
    throw new Refused(`Name one of these Linear teams: ${teams.map((t) => t.key).join(", ")}.`);
  const scope = { teamIds: [team.id] };
  const shown: string[] = [];
  const named = async <T extends { id: string; name: string }>(
    field: string,
    label: string,
    load: () => Promise<T[]>,
  ) => {
    const name = text(args[field]).trim();
    if (!name) return undefined;
    const found = (await load()).find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Refused(`No ${field} named "${name}" in ${team.key}.`);
    shown.push(`${label}: ${found.name}`);
    return found.id;
  };
  const projectId = await named("project", "Project", () => linear.listAgentProjects(scope));
  const wanted = Array.isArray(args["labels"]) ? args["labels"].map(text) : undefined;
  let labelIds: string[] | undefined;
  if (wanted) {
    const labels = await linear.listAgentLabels(scope);
    labelIds = wanted.map((name) => {
      const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
      if (!found) throw new Refused(`No label named "${name}" in ${team.key}.`);
      return found.id;
    });
    shown.push(`Labels: ${wanted.join(", ") || "none"}`);
  }
  const optional = { ...(projectId ? { projectId } : {}), ...(labelIds ? { labelIds } : {}) };
  const title = text(args["title"]).trim();
  const description = text(args["description"]).trim();
  const thread = {
    ...{ workspaceId: run.workspaceId, teamId: run.thread.teamId },
    ...{ channelId: run.thread.channelId, threadTs: run.thread.threadTs },
    ...{ slackUserId: run.slackUserId, generation: run.thread.installGeneration },
    ...{ userId: run.member.userId, linkId: run.member.linkId, mentionTs: run.mentionTs },
  };
  const base = { ...thread, id: "", team, acceptance: [] as string[], scope: "" };
  if (kind === "create") {
    if (!title || !description) throw new Refused("A new issue needs a title and a description.");
    const parent = text(args["parent"]) && (await issueOf(text(args["parent"])));
    const related = text(args["related_to"]) && (await issueOf(text(args["related_to"])));
    if (parent) shown.push(`Parent: ${parent.identifier}`);
    if (related) shown.push(`Related to: ${related.identifier}`);
    const start = args["start"] !== false;
    const links = {
      ...(parent ? { parentId: parent.id } : {}),
      ...(related ? { relatedId: related.id } : {}),
    };
    const change = { kind, run: run.requestId, shown, description, start, ...optional, ...links };
    return { ...base, title, change };
  }
  const { id: issueId, identifier } = target!;
  if (kind === "assign")
    return {
      ...base,
      title: target!.title,
      change: { kind, run: run.requestId, shown, issueId, identifier },
    };
  const stateId = await named("state", "State", () => linear.listAgentStates(scope));
  if (title) shown.unshift(`Title: ${title}`);
  if (description) shown.push(`Description: ${description}`);
  const fields = {
    ...optional,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(stateId ? { stateId } : {}),
  };
  if (!Object.keys(fields).length) throw new Refused("Name at least one field to change.");
  const change = { kind, run: run.requestId, shown, issueId, identifier, fields };
  return { ...base, title: target!.title, change };
}

function usable(tracker: SlackLinearReader | null | undefined): tracker is Linear {
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
