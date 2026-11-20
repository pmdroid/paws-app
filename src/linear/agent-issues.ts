import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";
import { stableUuid } from "./sub-issues";

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

export type AgentIssueRelationType = "related" | "blocks" | "blocked_by";

export type AgentIssueCreate = Record<"key" | "teamId" | "title" | "description", string> & {
  projectId?: string;
  labelIds?: readonly string[];
  parentId?: string;
  relation?: { issueId: string; type: AgentIssueRelationType };
  delegate: boolean;
};

export type AgentIssueUpdate = AgentIssueRead & {
  title?: string;
  description?: string;
  stateId?: string;
  labelIds?: readonly string[];
  projectId?: string;
  priority?: number;
};

export type AgentIssueRef = { id: string; identifier: string; url: string | null };

export const AGENT_ISSUE_LIMITS = { search: 10, maxSearch: 25, list: 100, comments: 20 } as const;
export const AGENT_ISSUE_WRITE_LIMITS = { title: 256, description: 20_000, labels: 10 } as const;
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

const LINKS = `relations(first: 50) { nodes { type relatedIssue { id identifier } } }
      inverseRelations(first: 50) { nodes { type issue { id identifier } } }`;

const EXISTING = `query AgentIssueExisting($ids: [ID!]!) {
  viewer { id }
  issues(first: 1, filter: { id: { in: $ids } }) {
    nodes { id identifier url team { id } ${LINKS} }
  }
}`;

const TARGET = `query AgentIssueTarget($filter: IssueFilter!) {
  viewer { id }
  issues(filter: $filter, first: 1) { nodes { id identifier url team { id } } }
}`;

const CREATE = `mutation AgentIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

const UPDATE = `mutation AgentIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
}`;

const RELATE = `mutation AgentIssueRelate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

const RELATION_TYPES: readonly string[] = ["related", "blocks", "blocked_by"];

export const agentIssueId = (key: string) => stableUuid(`paws:agent-issue:${key}`);

export function checkAgentIssueWrite(
  write: Partial<Pick<AgentIssueCreate, "title" | "description" | "labelIds">>,
): void {
  const limits = AGENT_ISSUE_WRITE_LIMITS;
  if (write.title !== undefined && !write.title.trim())
    throw new Error("A Linear issue needs a title");
  if ((write.title?.length ?? 0) > limits.title)
    throw new Error(`A Linear issue title has at most ${limits.title} characters`);
  if ((write.description?.length ?? 0) > limits.description)
    throw new Error(`A Linear issue description has at most ${limits.description} characters`);
  if ((write.labelIds?.length ?? 0) > limits.labels)
    throw new Error(`A Linear issue has at most ${limits.labels} labels`);
}

export function checkAgentIssueCreate(request: AgentIssueCreate): void {
  if (!request.key.trim() || !request.teamId.trim())
    throw new Error("A Linear issue needs a key and a team");
  if (request.relation && !RELATION_TYPES.includes(request.relation.type))
    throw new Error("A Linear issue relation is related, blocks or blocked_by");
  checkAgentIssueWrite(request);
}

export function checkAgentIssueUpdate(update: AgentIssueUpdate): void {
  const { priority } = update;
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 4))
    throw new Error("A Linear issue priority is a whole number from 0 to 4");
  checkAgentIssueWrite(update);
}

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
  const target = async ({ teamIds, id }: AgentIssueRead, options: Options | undefined) => {
    const filter = issueFilter(id, teamIds);
    if (!filter) return null;
    const data = await client.query(TARGET, { filter }, options);
    const node = nodes(data, "issues").find((candidate) => sameIssue(candidate, id.trim()));
    const ref = node && ownTeamId(node, teamIds) ? issueRef(node) : null;
    return ref && { ref, viewer: readString(record(record(data)["viewer"]), "id") };
  };
  const update = async (id: string, input: Node, options: Options | undefined) => {
    const payload = record(
      record(await client.query(UPDATE, { id, input }, options))["issueUpdate"],
    );
    const ref = payload["success"] === true ? issueRef(record(payload["issue"])) : null;
    if (!ref) throw new Error("Linear did not update the issue");
    return ref;
  };
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
      const filter = issueFilter(read.id, read.teamIds);
      if (!filter) return null;
      const found = nodes(await client.query(READ, { filter }, options), "issues");
      const node = found.find((candidate) => sameIssue(candidate, read.id.trim()));
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

    async createAgentIssue(request: AgentIssueCreate, options?: Options): Promise<AgentIssueRef> {
      checkAgentIssueCreate(request);
      options?.signal?.throwIfAborted();
      const id = agentIssueId(request.key);
      const data = await client.query(EXISTING, { ids: [id] }, options);
      let issue = nodes(data, "issues").find((node) => node["id"] === id);
      if (issue && ownTeamId(issue, [request.teamId]) === null)
        throw new Error("The agent issue exists in another team");
      if (!issue) {
        const delegateId = readString(record(record(data)["viewer"]), "id");
        if (request.delegate && !delegateId)
          throw new Error("Linear returned no app user to delegate the issue to");
        const { projectId, labelIds, parentId } = request;
        const input = {
          ...{ id, teamId: request.teamId, title: request.title, description: request.description },
          ...(request.delegate ? { delegateId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(labelIds?.length ? { labelIds: [...labelIds] } : {}),
          ...(parentId ? { parentId } : {}),
        };
        const payload = record(
          record(await client.query(CREATE, { input }, options))["issueCreate"],
        );
        if (payload["success"] !== true || !isRecord(payload["issue"]))
          throw new Error("Linear did not create the issue");
        issue = payload["issue"];
      }
      const ref = issueRef(issue);
      if (ref?.id !== id) throw new Error("Linear returned an unexpected issue");
      const relation = request.relation;
      if (relation && !hasRelation(issue, relation)) {
        const other = relation.issueId;
        const input =
          relation.type === "blocked_by"
            ? { issueId: other, relatedIssueId: id, type: "blocks" }
            : { issueId: id, relatedIssueId: other, type: relation.type };
        const payload = record(
          record(await client.query(RELATE, { input }, options))["issueRelationCreate"],
        );
        if (payload["success"] !== true) throw new Error("Linear did not relate the issue");
      }
      return ref;
    },

    async updateAgentIssue(
      request: AgentIssueUpdate,
      options?: Options,
    ): Promise<AgentIssueRef | null> {
      checkAgentIssueUpdate(request);
      const found = await target(request, options);
      if (!found) return null;
      const { title, description, stateId, labelIds, projectId, priority } = request;
      const fields = { title, description, stateId, projectId, priority, labelIds };
      const input = Object.fromEntries(
        Object.entries(fields)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
      );
      if (Object.keys(input).length === 0) return found.ref;
      return update(found.ref.id, input, options);
    },

    async assignAgentIssue(read: AgentIssueRead, options?: Options): Promise<AgentIssueRef | null> {
      const found = await target(read, options);
      if (!found) return null;
      if (!found.viewer) throw new Error("Linear returned no app user to delegate the issue to");
      return update(found.ref.id, { delegateId: found.viewer }, options);
    },
  };
}

function issueFilter(raw: string, teamIds: readonly string[]): Node | null {
  const id = raw.trim();
  const parts = IDENTIFIER.exec(id);
  if (teamIds.length === 0 || (!UUID.test(id) && !parts)) return null;
  const team = { id: { in: [...teamIds] } };
  return parts
    ? { team: { ...team, key: { eqIgnoreCase: parts[1] } }, number: { eq: +parts[2]! } }
    : { team, id: { eq: id } };
}

function sameIssue(node: Node, id: string): boolean {
  return IDENTIFIER.test(id)
    ? readString(node, "identifier")?.toUpperCase() === id.toUpperCase()
    : node["id"] === id;
}

function issueRef(node: Node): AgentIssueRef | null {
  const fields = pick(node, ["id", "identifier"]);
  return fields && { ...fields, url: readString(node, "url") };
}

function hasRelation(issue: Node, relation: NonNullable<AgentIssueCreate["relation"]>): boolean {
  const other = relation.issueId.trim().toUpperCase();
  const links = (key: string, side: string, type: string) =>
    nodes(issue[key]).some((link) => {
      const peer = record(link[side]);
      const ids = [readString(peer, "id"), readString(peer, "identifier")];
      return link["type"] === type && ids.some((value) => value?.toUpperCase() === other);
    });
  if (relation.type === "blocks") return links("relations", "relatedIssue", "blocks");
  if (relation.type === "blocked_by") return links("inverseRelations", "issue", "blocks");
  return (
    links("relations", "relatedIssue", "related") || links("inverseRelations", "issue", "related")
  );
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
  return ownTeamId(node, teamIds) && readString(record(node["team"]), "key");
}

function ownTeamId(node: Node, teamIds: readonly string[]): string | null {
  const id = readString(record(node["team"]), "id");
  return id && teamIds.includes(id) ? id : null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function nodes(value: unknown, key?: string): Node[] {
  const list = record(key ? record(value)[key] : value)["nodes"];
  return Array.isArray(list) ? list.filter(isRecord) : [];
}
