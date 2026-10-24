import { createLinearAttributionReads } from "./attribution";
import { createIssuePullRequestReads } from "./issue-pulls";
import { createLinearProjectMembers } from "./project-members";
import { createLinearProjectScopeReads } from "./project-scope";
import { createLinearAttachmentMethods } from "./attachments";
import type { createLinearSessionReads } from "./history";
import type { LinearSessionAdapter } from "./sessions";
import { createLinearSessionMethods } from "./sessions";
import type { LinearClient } from "./graphql";
import { linearDefaultCallers } from "./budget";
import { takeIssueStart, type IssueStartReads } from "./issue-start";
import { createLinearMergeReads } from "./merge-context";
import { createLinearRepositoryMethods, type LinearRepositoryAdapter } from "./repositories";
import { isRecord, readNumber, readString } from "./read";
import { schedulingMetadata } from "./scheduling";
import type { DependencyEdge, EpicSnapshot, LinearSubIssue, StatusUpdate } from "./types";

const CHILDREN_QUERY = `query IssueSnapshot($id: String!, $after: String) {
  issue(id: $id) {
    id
    identifier
    title
    description
    team { id }
    project { id }
    assignee { id }
    priority
    state { type }
    children(first: 50, after: $after) {
      nodes { id identifier title url description subIssueSortOrder state { type } team { id } project { id } assignee { id } priority }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const RELATIONS_QUERY = `query IssueRelations($id: String!, $relationsAfter: String, $inverseAfter: String, $includeRelations: Boolean!, $includeInverse: Boolean!) {
  issue(id: $id) {
    id
    relations(first: 50, after: $relationsAfter) @include(if: $includeRelations) {
      nodes { type issue { id } relatedIssue { id } }
      pageInfo { hasNextPage endCursor }
    }
    inverseRelations(first: 50, after: $inverseAfter) @include(if: $includeInverse) {
      nodes { type issue { id } relatedIssue { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const STATES_QUERY = `query IssueStates($id: String!) {
  issue(id: $id) {
    team {
      states(first: 50) { nodes { id name type } }
    }
  }
}`;

const STATUS_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const MAX_GRAPH_PAGES = 1_000;

const PREFERRED_STATE_NAMES: Record<StatusUpdate["stateType"], readonly string[]> = {
  started: ["In Progress"],
  completed: ["Done"],
  canceled: ["Canceled", "Cancelled"],
};

type LinearTracker = LinearSessionAdapter &
  ReturnType<typeof createLinearSessionReads> &
  LinearRepositoryAdapter &
  ReturnType<typeof createLinearAttributionReads> &
  ReturnType<typeof createLinearMergeReads>;

type TrackerMethod = {
  [K in keyof LinearTracker]-?: NonNullable<LinearTracker[K]> extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof LinearTracker];

const TRACKER_CALLERS: Record<TrackerMethod, string> = {
  getSession: "session-read",
  listSessionActivities: "session-activities",
  getIssueContext: "issue-context",
  createActivity: "activity-post",
  createElicitation: "elicitation-post",
  updateSession: "session-update",
  createSessionOnIssue: "session-create",
  createSessionOnComment: "session-create",
  listProjectMembers: "project-members",
  projectOverview: "project-overview",
  loadProject: "project-snapshot",
  getIssueAttribution: "issue-attribution",
  issueRepositorySuggestions: "repository-suggestions",
  issueRepositoryHints: "repository-hints",
  addRepositoryLabel: "repository-label",
  issueMergeContext: "merge-context",
  mergeChoices: "merge-choices",
  createIssueAttachment: "issue-attachment",
  listIssuePullRequests: "issue-pull-requests",
  loadEpic: "issue-snapshot",
  listDeps: "issue-relations",
  postProgress: "activity-post",
  postProgressWithSession: "activity-post",
  askQuestion: "elicitation-post",
  setStatus: "issue-status",
};

export function createLinearTracker(client: LinearClient, starts?: IssueStartReads): LinearTracker {
  return linearDefaultCallers(createUnlabelledTracker(client, starts), TRACKER_CALLERS);
}

function createUnlabelledTracker(client: LinearClient, starts?: IssueStartReads): LinearTracker {
  const sessions = createLinearSessionMethods(client);
  return {
    supportsActivityReconciliation: true,
    ...sessions,
    ...createLinearProjectMembers(client),
    ...createLinearProjectScopeReads(client),
    ...createLinearAttributionReads(client),
    ...createLinearRepositoryMethods(client),
    ...createLinearMergeReads(client, starts),
    ...createLinearAttachmentMethods(client),
    listIssuePullRequests: createIssuePullRequestReads(client),
    async loadEpic(linearIssueId) {
      const children = new Map<string, LinearSubIssue & { sort: number | null }>();
      const cursors = new Set<string>();
      let after: string | null = null;
      let snapshot: EpicSnapshot | null = null;
      let scheduling: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= MAX_GRAPH_PAGES)
          throw new Error("Linear graph pagination exceeded its page limit");
        const data =
          (page === 0 ? takeIssueStart(starts, linearIssueId, "epic") : undefined) ??
          (await client.query(CHILDREN_QUERY, { id: linearIssueId, after }));
        const issue = dig(data, ["issue"]);
        if (
          issue === null ||
          readString(issue, "id") === null ||
          (snapshot !== null && issue["id"] !== snapshot.linearIssueId)
        )
          throw new Error(
            `Linear issue ${linearIssueId} was not found or changed during pagination`,
          );
        if (snapshot === null) {
          const id = readString(issue, "id");
          const identifier = readString(issue, "identifier");
          const title = readString(issue, "title");
          if (id === null || identifier === null || title === null) {
            throw new Error("Linear issue snapshot was missing id, identifier, or title");
          }
          const description = issue["description"];
          const stateType = readString(dig(issue, ["state"]) ?? {}, "type");
          snapshot = {
            linearIssueId: id,
            identifier,
            title,
            description: typeof description === "string" ? description : null,
            ...(stateType === null ? {} : { stateType }),
            subIssues: [],
            ...schedulingMetadata(issue),
          };
          scheduling = JSON.stringify(schedulingMetadata(issue));
        }
        if (JSON.stringify(schedulingMetadata(issue)) !== scheduling)
          throw new Error("Linear issue scheduling changed during pagination");
        const connection = readGraphConnection(issue["children"]);
        for (const node of connection.nodes) {
          const id = readString(node, "id");
          const identifier = readString(node, "identifier");
          const title = readString(node, "title");
          if (id === null || identifier === null || title === null)
            throw new Error("Linear returned an invalid sub-issue");
          if (children.has(id)) throw new Error("Linear repeated a sub-issue during pagination");
          const url = readString(node, "url");
          children.set(id, {
            linearIssueId: id,
            identifier,
            title,
            description: readString(node, "description"),
            stateType: readString(dig(node, ["state"]) ?? {}, "type"),
            sort: readNumber(node, "subIssueSortOrder"),
            ...(url ? { url } : {}),
            ...schedulingMetadata(node),
          });
        }
        after = nextGraphCursor(connection, cursors);
        if (after === null) break;
      }
      if (snapshot === null) throw new Error(`Linear issue ${linearIssueId} was not found`);
      const ordered = [...children.values()].sort(
        (left, right) =>
          (left.sort ?? Number.POSITIVE_INFINITY) - (right.sort ?? Number.POSITIVE_INFINITY),
      );
      return { ...snapshot, subIssues: ordered.map(({ sort: _sort, ...child }) => child) };
    },
    async listDeps(linearIssueId) {
      const edges: DependencyEdge[] = [];
      const seen = new Set<string>();
      const relationCursors = new Set<string>();
      const inverseCursors = new Set<string>();
      let relationsAfter: string | null = null;
      let inverseAfter: string | null = null;
      let canonicalId: string | null = null;
      let relationsDone = false;
      let inverseDone = false;
      for (let page = 0; !relationsDone || !inverseDone; page++) {
        if (page >= MAX_GRAPH_PAGES)
          throw new Error("Linear graph pagination exceeded its page limit");
        const data =
          (page === 0 ? takeIssueStart(starts, linearIssueId, "deps") : undefined) ??
          (await client.query(RELATIONS_QUERY, {
            id: linearIssueId,
            relationsAfter,
            inverseAfter,
            includeRelations: !relationsDone,
            includeInverse: !inverseDone,
          }));
        const issue = dig(data, ["issue"]);
        const id = issue === null ? null : readString(issue, "id");
        if (issue === null || id === null || (canonicalId !== null && id !== canonicalId))
          throw new Error(
            `Linear issue ${linearIssueId} was not found or changed during pagination`,
          );
        canonicalId = id;
        if (!relationsDone) {
          const connection = readGraphConnection(issue["relations"]);
          pushEdges(connection.nodes, edges, seen);
          relationsAfter = nextGraphCursor(connection, relationCursors);
          relationsDone = relationsAfter === null;
        }
        if (!inverseDone) {
          const connection = readGraphConnection(issue["inverseRelations"]);
          pushEdges(connection.nodes, edges, seen);
          inverseAfter = nextGraphCursor(connection, inverseCursors);
          inverseDone = inverseAfter === null;
        }
      }
      return edges;
    },
    async postProgress(update, options) {
      await sessions.createActivity(update, options);
    },
    async postProgressWithSession(update, session, options) {
      await sessions.createActivity(update, options, session);
    },
    async askQuestion(question, options) {
      await sessions.createElicitation(question, options);
    },
    async setStatus(update, options) {
      options?.signal?.throwIfAborted();
      const data = await client.query(STATES_QUERY, { id: update.linearIssueId }, options);
      options?.signal?.throwIfAborted();
      const stateId = pickStateId(data, update.stateType);
      if (stateId === null) {
        throw new Error(`Linear issue ${update.linearIssueId} has no ${update.stateType} state`);
      }
      await client.query(
        STATUS_MUTATION,
        {
          id: update.linearIssueId,
          input: { stateId },
        },
        options,
      );
      options?.signal?.throwIfAborted();
    },
  };
}

function pickStateId(data: unknown, stateType: StatusUpdate["stateType"]): string | null {
  const issue = dig(data, ["issue"]);
  const team = issue === null ? null : dig(issue, ["team"]);
  const states = team === null ? null : readConnection(team["states"]);
  if (states === null) return null;
  const matches = states.nodes.filter((node) => readString(node, "type") === stateType);
  const preferred = PREFERRED_STATE_NAMES[stateType];
  const named = matches.find((node) => preferred.includes(readString(node, "name") ?? ""));
  return readString(named ?? matches[0] ?? {}, "id");
}

function pushEdges(
  nodes: Record<string, unknown>[],
  edges: DependencyEdge[],
  seen: Set<string>,
): void {
  for (const node of nodes) {
    const type = readString(node, "type");
    if (type === null) throw new Error("Linear returned an invalid relation");
    if (type !== "blocks") continue;
    const issue = isRecord(node["issue"]) ? node["issue"] : null;
    const related = isRecord(node["relatedIssue"]) ? node["relatedIssue"] : null;
    if (issue === null || related === null)
      throw new Error("Linear returned an invalid blocks relation");
    const blockerLinearIssueId = readString(issue, "id");
    const blockedLinearIssueId = readString(related, "id");
    if (blockerLinearIssueId === null || blockedLinearIssueId === null)
      throw new Error("Linear returned an invalid blocks relation");
    const key = `${blockerLinearIssueId}|${blockedLinearIssueId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ blockerLinearIssueId, blockedLinearIssueId });
  }
}

function dig(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function readConnection(value: unknown): {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  if (!isRecord(value)) return { nodes: [], hasNextPage: false, endCursor: null };
  const nodes = Array.isArray(value["nodes"]) ? value["nodes"].filter(isRecord) : [];
  const pageInfo = isRecord(value["pageInfo"]) ? value["pageInfo"] : null;
  return {
    nodes,
    hasNextPage: pageInfo?.["hasNextPage"] === true,
    endCursor: pageInfo === null ? null : readString(pageInfo, "endCursor"),
  };
}

function readGraphConnection(value: unknown) {
  if (
    !isRecord(value) ||
    !Array.isArray(value["nodes"]) ||
    !value["nodes"].every(isRecord) ||
    !isRecord(value["pageInfo"]) ||
    typeof value["pageInfo"]["hasNextPage"] !== "boolean"
  )
    throw new Error("Linear returned an invalid graph connection");
  return {
    nodes: value["nodes"],
    hasNextPage: value["pageInfo"]["hasNextPage"],
    endCursor: readString(value["pageInfo"], "endCursor"),
  };
}

function nextGraphCursor(
  connection: ReturnType<typeof readGraphConnection>,
  seen: Set<string>,
): string | null {
  if (!connection.hasNextPage) return null;
  const cursor = connection.endCursor;
  if (cursor === null || seen.has(cursor))
    throw new Error("Linear graph pagination did not advance");
  seen.add(cursor);
  return cursor;
}
