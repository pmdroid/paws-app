import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

type Options = TrackerRequestOptions;
type Node = Record<string, unknown>;

export type AgentTeamScope = { teamIds: readonly string[] };
export type AgentIssueSearch = AgentTeamScope & { query: string; limit?: number };
export type AgentIssueRead = AgentTeamScope & { id: string };

type Text = "id" | "identifier" | "title" | "teamKey" | "updatedAt";

export type AgentIssueRow = Record<Text, string> &
  Record<"url" | "assignee" | "delegate", string | null> & {
    state: { name: string; type: string } | null;
  };

export type AgentIssueRelation = {
  type: string;
  identifier: string;
  direction: "outgoing" | "incoming";
};

export type AgentIssueComment = { author: string | null; createdAt: string; body: string };

export type AgentIssue = AgentIssueRow &
  Record<"project" | "parent", string | null> & {
    description: string;
    labels: string[];
    relations: AgentIssueRelation[];
    comments: AgentIssueComment[];
  };

export type AgentTeam = { id: string; key: string; name: string; private: boolean };
export type AgentProject = { id: string; name: string; teamKey: string | null };
export type AgentLabel = { id: string; name: string; teamKey: string };
export type AgentState = { id: string; name: string; type: string; teamKey: string };

export const AGENT_ISSUE_LIMITS = { search: 10, maxSearch: 25, list: 100, comments: 20 } as const;
const TEXT_LIMITS = { description: 8_000, comment: 2_000 } as const;

const ROW = `id identifier title url updatedAt state { name type } team { id key } assignee { name } delegate { name }`;

const SEARCH = `query AgentIssueSearch($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ROW} } }
}`;

const READ = `query AgentIssueRead($filter: IssueFilter!) {
  issues(filter: $filter, first: 1) {
    nodes {
      ${ROW}
      description
      labels(first: 50) { nodes { name } }
      project { name }
      parent { identifier }
      relations(first: 50) { nodes { type relatedIssue { identifier } } }
      inverseRelations(first: 50) { nodes { type issue { identifier } } }
      comments(first: 20, orderBy: createdAt) {
        nodes { createdAt body user { name } botActor { name } externalUser { name } }
      }
    }
  }
}`;

const TEAMS = `query AgentTeams($ids: [ID!]!) {
  teams(filter: { id: { in: $ids } }, first: 100) { nodes { id key name private } }
}`;

const PROJECTS = `query AgentProjects($ids: [ID!]!) {
  projects(filter: { accessibleTeams: { some: { id: { in: $ids } } } }, first: 100) {
    nodes { id name teams(first: 50) { nodes { id key } } }
  }
}`;

const LABELS = `query AgentLabels($ids: [ID!]!) {
  issueLabels(filter: { team: { id: { in: $ids } } }, first: 100) { nodes { id name team { id key } } }
}`;

const STATES = `query AgentStates($ids: [ID!]!) {
  workflowStates(filter: { team: { id: { in: $ids } } }, first: 100) {
    nodes { id name type team { id key } }
  }
}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^([a-z][a-z0-9_]*)-(\d+)$/i;

export function agentSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return AGENT_ISSUE_LIMITS.search;
  return Math.min(AGENT_ISSUE_LIMITS.maxSearch, Math.max(1, Math.floor(limit)));
}

export function cutAgentIssue(issue: AgentIssue): AgentIssue {
  const comments = [...issue.comments]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, AGENT_ISSUE_LIMITS.comments)
    .map((comment) => ({ ...comment, body: comment.body.slice(0, TEXT_LIMITS.comment) }));
  const description = issue.description.slice(0, TEXT_LIMITS.description);
  return { ...issue, description, comments };
}

export function createLinearAgentIssueMethods(client: LinearClient) {
  const list = async <T>(
    [text, field]: readonly [string, string],
    { teamIds }: AgentTeamScope,
    options: Options | undefined,
    parse: (node: Node) => T | null,
  ): Promise<T[]> => {
    if (teamIds.length === 0) return [];
    const data = await client.query(text, { ids: [...teamIds] }, options);
    const found = nodes(data, field).map(parse);
    return found.filter((item) => item !== null).slice(0, AGENT_ISSUE_LIMITS.list);
  };
  return {
    async searchAgentIssues(search: AgentIssueSearch, options?: Options): Promise<AgentIssueRow[]> {
      if (search.teamIds.length === 0) return [];
      const limit = agentSearchLimit(search.limit);
      const filter: Record<string, unknown> = { team: { id: { in: [...search.teamIds] } } };
      const term = search.query.trim();
      const parts = IDENTIFIER.exec(term);
      if (term)
        filter["or"] = [
          { title: { containsIgnoreCase: term } },
          { description: { containsIgnoreCase: term } },
          ...(parts
            ? [{ team: { key: { eqIgnoreCase: parts[1] } }, number: { eq: +parts[2]! } }]
            : []),
        ];
      const data = await client.query(SEARCH, { filter, first: limit }, options);
      return nodes(data, "issues")
        .map((node) => issueRow(node, search.teamIds))
        .filter((row) => row !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    },

    async readAgentIssue(read: AgentIssueRead, options?: Options): Promise<AgentIssue | null> {
      const id = read.id.trim();
      const parts = IDENTIFIER.exec(id);
      if (read.teamIds.length === 0 || (!UUID.test(id) && !parts)) return null;
      const team = { id: { in: [...read.teamIds] } };
      const filter = parts
        ? { team: { ...team, key: { eqIgnoreCase: parts[1] } }, number: { eq: +parts[2]! } }
        : { team, id: { eq: id } };
      const found = nodes(await client.query(READ, { filter }, options), "issues");
      const node = found.find((candidate) =>
        parts
          ? readString(candidate, "identifier")?.toUpperCase() === id.toUpperCase()
          : candidate["id"] === id,
      );
      const row = node && issueRow(node, read.teamIds);
      if (!node || !row) return null;
      const relation =
        (direction: AgentIssueRelation["direction"], key: string) => (value: Node) => {
          const identifier = readString(record(value[key]), "identifier");
          const type = readString(value, "type");
          return type && identifier ? [{ type, identifier, direction }] : [];
        };
      return cutAgentIssue({
        ...row,
        description: readString(node, "description") ?? "",
        labels: nodes(node["labels"]).flatMap((label) => readString(label, "name") ?? []),
        project: readString(record(node["project"]), "name"),
        parent: readString(record(node["parent"]), "identifier"),
        relations: [
          ...nodes(node["relations"]).flatMap(relation("outgoing", "relatedIssue")),
          ...nodes(node["inverseRelations"]).flatMap(relation("incoming", "issue")),
        ],
        comments: nodes(node["comments"]).flatMap((comment) => {
          const createdAt = readString(comment, "createdAt");
          if (!createdAt || typeof comment["body"] !== "string") return [];
          const author = ["user", "botActor", "externalUser"]
            .map((key) => readString(record(comment[key]), "name"))
            .find((name) => name !== null);
          return [{ author: author ?? null, createdAt, body: comment["body"] }];
        }),
      });
    },

    listAgentTeams: (scope: AgentTeamScope, options?: Options): Promise<AgentTeam[]> =>
      list([TEAMS, "teams"], scope, options, (team) => {
        const fields = pick(team, ["id", "key"]);
        if (!fields || !scope.teamIds.includes(fields.id) || typeof team["private"] !== "boolean")
          return null;
        return {
          ...fields,
          name: readString(team, "name") ?? fields.key,
          private: team["private"],
        };
      }),

    listAgentProjects: (scope: AgentTeamScope, options?: Options): Promise<AgentProject[]> =>
      list([PROJECTS, "projects"], scope, options, (project) => {
        const fields = pick(project, ["id", "name"]);
        const teams = nodes(project["teams"]);
        const ids = teams.map((team) => readString(team, "id"));
        if (!fields || !ids.some((id) => id && scope.teamIds.includes(id))) return null;
        return { ...fields, teamKey: teams.length === 1 ? readString(teams[0]!, "key") : null };
      }),

    listAgentLabels: (scope: AgentTeamScope, options?: Options): Promise<AgentLabel[]> =>
      list([LABELS, "issueLabels"], scope, options, (label) =>
        owned(label, pick(label, ["id", "name"]), scope),
      ),

    listAgentStates: (scope: AgentTeamScope, options?: Options): Promise<AgentState[]> =>
      list([STATES, "workflowStates"], scope, options, (state) =>
        owned(state, pick(state, ["id", "name", "type"]), scope),
      ),
  };
}

function owned<T extends object>(node: Node, fields: T | null, { teamIds }: AgentTeamScope) {
  const teamKey = ownTeamKey(node, teamIds);
  return fields && teamKey ? { ...fields, teamKey } : null;
}

function pick<K extends string>(node: Node, keys: readonly K[]) {
  const values = keys.map((key) => readString(node, key));
  if (values.some((value) => value === null)) return null;
  return Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Record<K, string>;
}

function issueRow(node: Node, teamIds: readonly string[]): AgentIssueRow | null {
  const fields = pick(node, ["id", "identifier", "updatedAt"]);
  const teamKey = ownTeamKey(node, teamIds);
  if (!fields || !teamKey) return null;
  const state = pick(record(node["state"]), ["name", "type"]);
  return {
    ...fields,
    title: readString(node, "title") ?? "",
    url: readString(node, "url"),
    state,
    teamKey,
    assignee: readString(record(node["assignee"]), "name"),
    delegate: readString(record(node["delegate"]), "name"),
  };
}

function ownTeamKey(node: Node, teamIds: readonly string[]): string | null {
  const team = record(node["team"]);
  const id = readString(team, "id");
  return id && teamIds.includes(id) ? readString(team, "key") : null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function nodes(value: unknown, key?: string): Node[] {
  const list = record(key ? record(value)[key] : value)["nodes"];
  return Array.isArray(list) ? list.filter(isRecord) : [];
}
