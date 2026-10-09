import type { TrackerAdapter } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readNumber, readString } from "./read";
import type {
  DependencyEdge,
  Elicitation,
  EpicSnapshot,
  LinearSubIssue,
  ProgressUpdate,
  StatusUpdate,
} from "./types";

const CHILDREN_QUERY = `query IssueSnapshot($id: String!, $after: String) {
  issue(id: $id) {
    id
    identifier
    title
    description
    children(first: 50, after: $after) {
      nodes { id identifier title subIssueSortOrder }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const RELATIONS_QUERY = `query IssueRelations($id: String!, $relationsAfter: String, $inverseAfter: String) {
  issue(id: $id) {
    relations(first: 50, after: $relationsAfter) {
      nodes { type issue { id } relatedIssue { id } }
      pageInfo { hasNextPage endCursor }
    }
    inverseRelations(first: 50, after: $inverseAfter) {
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

const ACTIVITY_MUTATION = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success }
}`;

const STATUS_MUTATION = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const PREFERRED_STATE_NAMES: Record<StatusUpdate["stateType"], readonly string[]> = {
  started: ["In Progress"],
  completed: ["Done"],
  canceled: ["Canceled", "Cancelled"],
};

export function createLinearTracker(client: LinearClient): TrackerAdapter {
  return {
    async loadEpic(linearIssueId) {
      const children: Array<LinearSubIssue & { sort: number | null }> = [];
      let after: string | null = null;
      let snapshot: EpicSnapshot | null = null;
      for (let page = 0; page < 10; page++) {
        const data = await client.query(CHILDREN_QUERY, { id: linearIssueId, after });
        const issue = dig(data, ["issue"]);
        if (issue === null) throw new Error(`Linear issue ${linearIssueId} was not found`);
        if (snapshot === null) {
          const id = readString(issue, "id");
          const identifier = readString(issue, "identifier");
          const title = readString(issue, "title");
          if (id === null || identifier === null || title === null) {
            throw new Error("Linear issue snapshot was missing id, identifier, or title");
          }
          const description = issue["description"];
          snapshot = {
            linearIssueId: id,
            identifier,
            title,
            description: typeof description === "string" ? description : null,
            subIssues: [],
          };
        }
        const connection = readConnection(issue["children"]);
        for (const node of connection.nodes) {
          const id = readString(node, "id");
          const identifier = readString(node, "identifier");
          const title = readString(node, "title");
          if (id === null || identifier === null || title === null) continue;
          children.push({
            linearIssueId: id,
            identifier,
            title,
            sort: readNumber(node, "subIssueSortOrder"),
          });
        }
        if (!connection.hasNextPage || connection.endCursor === null) break;
        after = connection.endCursor;
      }
      if (snapshot === null) throw new Error(`Linear issue ${linearIssueId} was not found`);
      children.sort(
        (left, right) =>
          (left.sort ?? Number.POSITIVE_INFINITY) - (right.sort ?? Number.POSITIVE_INFINITY),
      );
      return { ...snapshot, subIssues: children.map(({ sort: _sort, ...child }) => child) };
    },
    async listDeps(linearIssueId) {
      const edges: DependencyEdge[] = [];
      const seen = new Set<string>();
      let relationsAfter: string | null = null;
      let inverseAfter: string | null = null;
      let relationsDone = false;
      let inverseDone = false;
      for (let page = 0; page < 10 && (!relationsDone || !inverseDone); page++) {
        const data = await client.query(RELATIONS_QUERY, {
          id: linearIssueId,
          relationsAfter,
          inverseAfter,
        });
        const issue = dig(data, ["issue"]);
        if (issue === null) break;
        if (!relationsDone) {
          const connection = readConnection(issue["relations"]);
          pushEdges(connection.nodes, edges, seen);
          relationsDone = !connection.hasNextPage || connection.endCursor === null;
          relationsAfter = connection.endCursor;
        }
        if (!inverseDone) {
          const connection = readConnection(issue["inverseRelations"]);
          pushEdges(connection.nodes, edges, seen);
          inverseDone = !connection.hasNextPage || connection.endCursor === null;
          inverseAfter = connection.endCursor;
        }
      }
      return edges;
    },
    async postProgress(update) {
      await client.query(ACTIVITY_MUTATION, { input: activityInput(update) });
    },
    async askQuestion(question) {
      await client.query(ACTIVITY_MUTATION, { input: elicitationInput(question) });
    },
    async setStatus(update) {
      const data = await client.query(STATES_QUERY, { id: update.linearIssueId });
      const stateId = pickStateId(data, update.stateType);
      if (stateId === null) {
        throw new Error(`Linear issue ${update.linearIssueId} has no ${update.stateType} state`);
      }
      await client.query(STATUS_MUTATION, {
        id: update.linearIssueId,
        input: { stateId },
      });
    },
  };
}

function activityInput(update: ProgressUpdate): Record<string, unknown> {
  const content =
    update.kind === "action"
      ? { type: "action", action: "update", parameter: update.body }
      : { type: update.kind, body: update.body };
  return { agentSessionId: update.sessionId, content };
}

function elicitationInput(question: Elicitation): Record<string, unknown> {
  const options = question.options ?? [];
  const input: Record<string, unknown> = {
    agentSessionId: question.sessionId,
    content: { type: "elicitation", body: question.body },
  };
  if (options.length === 0) return input;
  input["signal"] = "select";
  input["signalMetadata"] = {
    options: options.map((option) => ({ label: option, value: option })),
  };
  return input;
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
    if (readString(node, "type") !== "blocks") continue;
    const issue = isRecord(node["issue"]) ? node["issue"] : null;
    const related = isRecord(node["relatedIssue"]) ? node["relatedIssue"] : null;
    if (issue === null || related === null) continue;
    const blockerLinearIssueId = readString(issue, "id");
    const blockedLinearIssueId = readString(related, "id");
    if (blockerLinearIssueId === null || blockedLinearIssueId === null) continue;
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
