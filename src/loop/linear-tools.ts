import type { RunAgentOptions } from "../acp";
import {
  getLinearSessionSteps,
  getLinearTaskDelegationSteps,
  getTaskModeSteps,
  listRunsSteps,
  workspaceForOrganizationSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceUserIdForLinearUserSteps,
  type Db,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import { agentIssueId, type AgentIssue, type TrackerAdapter } from "../linear";

export type HostTools = NonNullable<RunAgentOptions["hostTools"]>;
type Args = Record<string, unknown>;
type Linear = Required<
  Pick<
    TrackerAdapter,
    | "searchAgentIssues"
    | "readAgentIssue"
    | "listAgentTeams"
    | "listAgentProjects"
    | "listAgentLabels"
    | "listAgentStates"
    | "createAgentIssue"
    | "updateAgentIssue"
    | "assignAgentIssue"
  >
>;

export const LINEAR_TOOL_LIMITS = { answerBytes: 16_384, filedPerRun: 3 } as const;

export const LINEAR_TOOLS_NOTE = [
  "Linear tools: search_issues, get_issue and list_teams, list_projects, list_labels, list_states read the teams of the person who delegated this issue.",
  "create_issue files a follow-up in this issue's team, related to it, at most 3 per run; it is not handed to Paws unless you pass start: true.",
  "update_issue and assign_issue change only this issue and the issues you filed with create_issue.",
].join("\n");

export const NOT_YOURS = "You can change only your own issue and the ones you filed.";

const string = { type: "string" };
const strings = { type: "array", items: string };
const schema = (properties: Args, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const list = (name: string, what: string) => ({
  name,
  description: `List the ${what} of the delegating person's Linear teams.`,
  inputSchema: schema({}),
});

const DEFINITIONS = [
  {
    name: "search_issues",
    description: "Search Linear issues by text or identifier in the delegating person's teams.",
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
      "File a follow-up Linear issue in this issue's team, related to this issue. At most 3 per run. labels are names; start: true hands it to Paws.",
    inputSchema: schema(
      { title: string, description: string, labels: strings, start: { type: "boolean" } },
      ["title", "description"],
    ),
  },
  {
    name: "update_issue",
    description:
      "Change this issue or one you filed: title, description, state (name) or labels (names).",
    inputSchema: schema(
      { id: string, title: string, description: string, state: string, labels: strings },
      ["id"],
    ),
  },
  {
    name: "assign_issue",
    description: "Hand this issue or one you filed to Paws.",
    inputSchema: schema({ id: string }, ["id"]),
  },
];

export type LinearToolsInput = {
  store: Db;
  tracker: TrackerAdapter | null;
  item: WorkItemRecord;
  runId: string;
  filed: Map<string, number>;
};

export async function linearToolScope(
  store: Db,
  tracker: TrackerAdapter | null,
  item: WorkItemRecord,
) {
  if (!usable(tracker)) return null;
  const found = await store.run(function* (q) {
    const mode = yield* getTaskModeSteps(q, item.id);
    if (mode !== null && mode !== "code") return null;
    const delegation = yield* getLinearTaskDelegationSteps(q, item.id, item.linearIssueId);
    return delegation && { teamId: delegation.teamId };
  });
  if (!found || !(await delegatorTeams(store, item))) return null;
  return { linear: tracker, teamId: found.teamId };
}

export async function linearToolsFor(input: LinearToolsInput): Promise<HostTools | undefined> {
  const { store, item, runId, filed } = input;
  const scope = await linearToolScope(store, input.tracker, item);
  if (!scope) return undefined;
  const { linear, teamId } = scope;
  const own = { teamIds: [teamId] };
  const teams = async () => {
    const teamIds = await delegatorTeams(store, item);
    if (!teamIds) throw new Error("The person who delegated this issue is no longer a member.");
    return { teamIds };
  };
  const named = async (kind: "labels" | "states", names: unknown[]) => {
    const all = await (kind === "labels"
      ? linear.listAgentLabels(own)
      : linear.listAgentStates(own));
    return names.map((name) => {
      const value = String(name).trim().toLowerCase();
      const hit = all.find((entry) => entry.id === name || entry.name.toLowerCase() === value);
      if (!hit)
        throw new Error(`No ${kind === "labels" ? "label" : "state"} named ${String(name)}.`);
      return hit.id;
    });
  };
  const labels = async (value: unknown) =>
    Array.isArray(value) ? { labelIds: await named("labels", value) } : {};
  const mine = async (id: unknown) => {
    const issue = await linear.readAgentIssue({ ...own, id: text(id) });
    if (!issue) return null;
    if (issue.id === item.linearIssueId) return issue.id;
    const runs = await store.run((q) => listRunsSteps(q, item.id));
    const ids = new Set([...runs.map((run) => run.id), runId]);
    const keys = [...ids].flatMap((run) =>
      Array.from(
        { length: LINEAR_TOOL_LIMITS.filedPerRun },
        (_, n) => `${item.id}:${run}:${n + 1}`,
      ),
    );
    return keys.some((key) => agentIssueId(key) === issue.id) ? issue.id : null;
  };
  const create = async (args: Args) => {
    const n = (filed.get(runId) ?? 0) + 1;
    if (n > LINEAR_TOOL_LIMITS.filedPerRun)
      throw new Error(`You can file at most ${LINEAR_TOOL_LIMITS.filedPerRun} issues in one run.`);
    filed.set(runId, n);
    try {
      const description = `${text(args["description"]).trim()}\n\nFiled from ${item.linearIdentifier}.`;
      return await linear.createAgentIssue({
        key: `${item.id}:${runId}:${n}`,
        teamId,
        title: text(args["title"]),
        description,
        ...(await labels(args["labels"])),
        relation: { issueId: item.linearIssueId, type: "related" },
        delegate: args["start"] === true,
      });
    } catch (error) {
      if (filed.get(runId) === n) filed.set(runId, n - 1);
      throw error;
    }
  };
  const calls: Record<string, (args: Args) => Promise<unknown>> = {
    search_issues: async (args) =>
      linear.searchAgentIssues({
        ...(await teams()),
        query: text(args["query"]),
        ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
      }),
    get_issue: async (args) =>
      (await linear.readAgentIssue({ ...(await teams()), id: text(args["id"]) })) ??
      `No issue ${text(args["id"])} in your teams.`,
    list_teams: async () => linear.listAgentTeams(await teams()),
    list_projects: async () => linear.listAgentProjects(await teams()),
    list_labels: async () => linear.listAgentLabels(await teams()),
    list_states: async () => linear.listAgentStates(await teams()),
    create_issue: create,
    update_issue: async (args) => {
      const id = await mine(args["id"]);
      if (!id) throw new Error(NOT_YOURS);
      const [stateId] =
        typeof args["state"] === "string" ? await named("states", [args["state"]]) : [];
      return linear.updateAgentIssue({
        ...own,
        id,
        ...(typeof args["title"] === "string" ? { title: args["title"] } : {}),
        ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
        ...(stateId ? { stateId } : {}),
        ...(await labels(args["labels"])),
      });
    },
    assign_issue: async (args) => {
      const id = await mine(args["id"]);
      if (!id) throw new Error(NOT_YOURS);
      return linear.assignAgentIssue({ ...own, id });
    },
  };
  return {
    definitions: DEFINITIONS,
    async call(name, args) {
      const run = calls[name];
      if (!run) return { text: `Unknown tool ${name}.`, isError: true };
      try {
        const result = await run(args);
        return { text: typeof result === "string" ? result : fit(result) };
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}

export function* delegatorSteps(
  q: Q,
  item: WorkItemRecord,
): Steps<{ workspaceId: string; userId: string; teamIds: string[] } | null> {
  if (!item.sessionKey) return null;
  const session = yield* getLinearSessionSteps(q, item.sessionKey);
  if (!session?.organizationId || !session.creatorId) return null;
  const workspace = yield* workspaceForOrganizationSteps(q, session.organizationId);
  const userId = yield* workspaceUserIdForLinearUserSteps(q, session.creatorId);
  if (!workspace || !userId) return null;
  const member = yield* workspaceMemberSteps(q, workspace.id, userId);
  return workspaceMemberUsable(member)
    ? { workspaceId: workspace.id, userId, teamIds: [...member.teamIds] }
    : null;
}

async function delegatorTeams(store: Db, item: WorkItemRecord): Promise<string[] | null> {
  return (await store.run((q) => delegatorSteps(q, item)))?.teamIds ?? null;
}

function usable(tracker: TrackerAdapter | null): tracker is TrackerAdapter & Linear {
  return !!tracker && LINEAR_METHODS.every((key) => typeof tracker[key] === "function");
}

const LINEAR_METHODS = [
  "searchAgentIssues",
  "readAgentIssue",
  "listAgentTeams",
  "listAgentProjects",
  "listAgentLabels",
  "listAgentStates",
  "createAgentIssue",
  "updateAgentIssue",
  "assignAgentIssue",
] as const satisfies readonly (keyof Linear)[];

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function fit(value: unknown): string {
  const limit = LINEAR_TOOL_LIMITS.answerBytes;
  if (bytes(value) <= limit) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const rows = [...value];
    while (rows.length && bytes(rows) > limit) rows.pop();
    return JSON.stringify(rows);
  }
  const issue = { ...(value as AgentIssue) };
  while (issue.comments.length && bytes(issue) > limit)
    issue.comments = issue.comments.slice(0, -1);
  while (issue.description && bytes(issue) > limit)
    issue.description = issue.description.slice(0, Math.floor(issue.description.length * 0.9));
  return JSON.stringify(issue);
}
