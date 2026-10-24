import { linearDefaultCallers } from "./budget";
import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { keepIssueStart, type IssueStartReads } from "./issue-start";
import { isRecord, readNumber, readString } from "./read";
import { schedulingMetadata } from "./scheduling";

export type LinearIssueOwnership = {
  id: string;
  identifier?: string;
  /** The issue's page in Linear, when the read included it. */
  url?: string;
  teamId: string;
  assigneeId: string | null;
  delegateId: string | null;
  projectId?: string | null;
  stateType: string;
};

export type StartLinearCodeIssue = {
  issueId: string;
  appUserId: string;
  actorId: string | null;
};

export type StartLinearCodeIssueOptions = TrackerRequestOptions & {
  issue?: LinearIssueOwnership;
  beforeStart?: (issue: LinearIssueOwnership) => void;
};

export interface LinearIssueLifecycle {
  inspect(issueId: string, options?: TrackerRequestOptions): Promise<LinearIssueOwnership>;
  inspectStart?(
    issueId: string,
    actorId: string | null,
    options?: TrackerRequestOptions,
  ): Promise<LinearIssueOwnership>;
  startCodeIssue(
    input: StartLinearCodeIssue,
    options?: StartLinearCodeIssueOptions,
  ): Promise<{ issue: LinearIssueOwnership; eligible: boolean }>;
}

const ISSUE = `query IssueOwnership($id: String!) {
  issue(id: $id) { id identifier url team { id } state { type } assignee { id } delegate { id } project { id } }
}`;

const PAGE = "pageInfo { hasNextPage endCursor }";
const RELATION = "nodes { type issue { id } relatedIssue { id } }";
const START = `query IssueStart($id: String!, $actor: String!, $hasActor: Boolean!) {
  issue(id: $id) {
    id identifier title description url priority
    team { id states(first: 50, filter: { type: { eq: "started" } }) { nodes { id position } ${PAGE} } }
    project { id name content lead { id } } assignee { id } delegate { id } state { type }
    labels(first: 100) { nodes { name } }
    children(first: 50) {
      nodes { id identifier title url description subIssueSortOrder state { type } team { id } project { id lead { id } } assignee { id } priority }
      ${PAGE}
    }
    relations(first: 50) { ${RELATION} ${PAGE} }
    inverseRelations(first: 50) { ${RELATION} ${PAGE} }
  }
  user(id: $actor) @include(if: $hasActor) { id app }
}`;

const ACTOR = `query CodeTaskActor($id: String!) {
  user(id: $id) { id app }
}`;

const STATES = `query StartedWorkflowStates($id: String!, $after: String) {
  team(id: $id) {
    states(first: 50, after: $after, filter: { type: { eq: "started" } }) {
      nodes { id position }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const UPDATE = `mutation StartDelegatedIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export function createLinearIssueLifecycle(
  client: LinearClient,
  starts?: IssueStartReads,
): LinearIssueLifecycle {
  return linearDefaultCallers(createUnlabelledLifecycle(client, starts), {
    inspect: "issue-inspect",
    inspectStart: "issue-inspect",
    startCodeIssue: "issue-start",
  });
}

function createUnlabelledLifecycle(
  client: LinearClient,
  starts?: IssueStartReads,
): LinearIssueLifecycle {
  const humans = new Set<string>();
  const startedStates = new Map<string, string>();

  async function inspect(issueId: string, options?: TrackerRequestOptions) {
    options?.signal?.throwIfAborted();
    const data = await client.query(ISSUE, { id: issueId }, options);
    options?.signal?.throwIfAborted();
    return ownership(data, issueId);
  }

  function ownership(data: unknown, issueId: string): LinearIssueOwnership {
    const issue = child(data, "issue");
    const id = issue === null ? null : readString(issue, "id");
    const teamId = readString(child(issue, "team") ?? {}, "id");
    const stateType = readString(child(issue, "state") ?? {}, "type");
    if (issue === null || id !== issueId || teamId === null || stateType === null)
      throw new Error("Linear returned incomplete issue ownership.");
    return {
      ...schedulingMetadata(issue),
      id,
      ...(readString(issue, "identifier") ? { identifier: readString(issue, "identifier")! } : {}),
      ...(readString(issue, "url") ? { url: readString(issue, "url")! } : {}),
      teamId,
      stateType,
      assigneeId: nullableOwner(issue, "assignee"),
      delegateId: nullableOwner(issue, "delegate"),
    };
  }

  return {
    inspect,
    async inspectStart(issueId, actorId, options) {
      options?.signal?.throwIfAborted();
      const data = await client.query(
        START,
        { id: issueId, actor: actorId ?? "", hasActor: actorId !== null },
        options,
      );
      options?.signal?.throwIfAborted();
      const issue = ownership(data, issueId);
      const actor = child(data, "user");
      if (actorId !== null && actor?.["id"] === actorId && actor["app"] === false)
        humans.add(actorId);
      const states = child(child(child(data, "issue"), "team"), "states");
      const started = Array.isArray(states?.["nodes"])
        ? states["nodes"]
            .filter(isRecord)
            .flatMap((node) => {
              const id = readString(node, "id");
              const position = readNumber(node, "position");
              return id === null || position === null ? [] : [{ id, position }];
            })
            .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        : [];
      if (child(states, "pageInfo")?.["hasNextPage"] === false && started[0])
        startedStates.set(issue.teamId, started[0].id);
      if (starts) keepIssueStart(starts, issueId, data);
      return issue;
    },
    async startCodeIssue(input, options) {
      if (input.appUserId.trim() === "") throw new Error("The Linear app user is not configured.");
      const issue =
        options?.issue?.id === input.issueId
          ? options.issue
          : await inspect(input.issueId, options);
      if (!humanCodeOwnership(issue, input)) return { issue, eligible: false };
      if (!humans.has(input.actorId!)) {
        const actor = child(await client.query(ACTOR, { id: input.actorId }, options), "user");
        options?.signal?.throwIfAborted();
        if (actor?.["id"] !== input.actorId || actor["app"] !== false)
          return { issue, eligible: false };
        humans.add(input.actorId!);
      }
      let stateId: string | null = null;
      if (issue.stateType !== "started") {
        stateId = startedStates.get(issue.teamId) ?? null;
        if (stateId === null) {
          stateId = await startedState(issue.teamId, options);
          startedStates.set(issue.teamId, stateId);
        }
      }
      options?.signal?.throwIfAborted();
      options?.beforeStart?.(issue);
      options?.signal?.throwIfAborted();
      const change: { stateId?: string; delegateId?: string } = {};
      if (issue.stateType !== "started" && stateId !== null) change.stateId = stateId;
      if (issue.delegateId === null) change.delegateId = input.appUserId;
      if (Object.keys(change).length > 0) {
        const result = await client
          .query(UPDATE, { id: issue.id, input: change }, options)
          .catch((error: unknown) => {
            startedStates.delete(issue.teamId);
            throw error;
          });
        options?.signal?.throwIfAborted();
        if (child(result, "issueUpdate")?.["success"] !== true) {
          startedStates.delete(issue.teamId);
          throw new Error("Linear did not accept the issue delegation update.");
        }
      }
      return {
        issue: { ...issue, delegateId: issue.delegateId ?? input.appUserId, stateType: "started" },
        eligible: true,
      };
    },
  };

  async function startedState(teamId: string, options?: TrackerRequestOptions): Promise<string> {
    let after: string | null = null;
    const states: { id: string; position: number }[] = [];
    for (let page = 0; page < 100; page++) {
      options?.signal?.throwIfAborted();
      const result = await client.query(STATES, { id: teamId, after }, options);
      options?.signal?.throwIfAborted();
      const connection = child(child(result, "team"), "states");
      if (connection === null || !Array.isArray(connection["nodes"]))
        throw new Error("Linear returned incomplete workflow states.");
      for (const node of connection["nodes"]) {
        if (!isRecord(node)) continue;
        const id = readString(node, "id");
        const position = readNumber(node, "position");
        if (id !== null && position !== null) states.push({ id, position });
      }
      const pagination = child(connection, "pageInfo");
      if (pagination?.["hasNextPage"] === false) {
        states.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
        if (!states[0]) throw new Error("The Linear team has no started workflow state.");
        return states[0].id;
      }
      const cursor = pagination === null ? null : readString(pagination, "endCursor");
      if (cursor === null || cursor === after)
        throw new Error("Linear returned incomplete workflow state pagination.");
      after = cursor;
    }
    throw new Error("Linear workflow state pagination did not finish.");
  }
}

function humanCodeOwnership(issue: LinearIssueOwnership, input: StartLinearCodeIssue): boolean {
  return (
    input.actorId !== null &&
    input.actorId.trim() !== "" &&
    input.actorId !== input.appUserId &&
    ["triage", "backlog", "unstarted", "started"].includes(issue.stateType) &&
    (issue.delegateId === null || issue.delegateId === input.appUserId)
  );
}

function child(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value[key]) ? value[key] : null;
}

function nullableOwner(issue: Record<string, unknown>, key: string): string | null {
  if (issue[key] === null) return null;
  const id = readString(child(issue, key) ?? {}, "id");
  if (id === null) throw new Error("Linear returned incomplete issue ownership.");
  return id;
}
