import { linearDefaultCallers } from "./budget";
import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readNumber, readString } from "./read";
import { schedulingMetadata } from "./scheduling";

export type LinearIssueOwnership = {
  id: string;
  identifier?: string;
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
  beforeStart?: (issue: LinearIssueOwnership) => void;
};

export interface LinearIssueLifecycle {
  inspect(issueId: string, options?: TrackerRequestOptions): Promise<LinearIssueOwnership>;
  startCodeIssue(
    input: StartLinearCodeIssue,
    options?: StartLinearCodeIssueOptions,
  ): Promise<{ issue: LinearIssueOwnership; eligible: boolean }>;
}

const ISSUE = `query IssueOwnership($id: String!) {
  issue(id: $id) { id identifier team { id } state { type } assignee { id } delegate { id } project { id } }
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

export function createLinearIssueLifecycle(client: LinearClient): LinearIssueLifecycle {
  return linearDefaultCallers(createUnlabelledLifecycle(client), {
    inspect: "issue-inspect",
    startCodeIssue: "issue-start",
  });
}

function createUnlabelledLifecycle(client: LinearClient): LinearIssueLifecycle {
  async function inspect(issueId: string, options?: TrackerRequestOptions) {
    options?.signal?.throwIfAborted();
    const data = await client.query(ISSUE, { id: issueId }, options);
    options?.signal?.throwIfAborted();
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
      teamId,
      stateType,
      assigneeId: nullableOwner(issue, "assignee"),
      delegateId: nullableOwner(issue, "delegate"),
    };
  }

  return {
    inspect,
    async startCodeIssue(input, options) {
      if (input.appUserId.trim() === "") throw new Error("The Linear app user is not configured.");
      const first = await inspect(input.issueId, options);
      if (!humanCodeOwnership(first, input)) return { issue: first, eligible: false };
      const actor = child(await client.query(ACTOR, { id: input.actorId }, options), "user");
      options?.signal?.throwIfAborted();
      if (actor?.["id"] !== input.actorId || actor["app"] !== false)
        return { issue: first, eligible: false };
      let stateId: string | null = null;
      if (first.stateType !== "started") stateId = await startedState(first.teamId, options);
      const issue = await inspect(input.issueId, options);
      if (!humanCodeOwnership(issue, input)) return { issue, eligible: false };
      if (issue.teamId !== first.teamId) throw new Error("The Linear issue changed teams.");
      if (issue.stateType !== "started" && stateId === null)
        throw new Error("The Linear issue changed workflow state.");
      options?.signal?.throwIfAborted();
      options?.beforeStart?.(issue);
      options?.signal?.throwIfAborted();
      const change: { stateId?: string; delegateId?: string } = {};
      if (issue.stateType !== "started" && stateId !== null) change.stateId = stateId;
      if (issue.delegateId === null) change.delegateId = input.appUserId;
      if (Object.keys(change).length > 0) {
        const result = await client.query(UPDATE, { id: issue.id, input: change }, options);
        options?.signal?.throwIfAborted();
        if (child(result, "issueUpdate")?.["success"] !== true)
          throw new Error("Linear did not accept the issue delegation update.");
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
