import { LinearRateLimitError } from "./budget";
import {
  LinearEntityNotFoundError,
  LinearGraphQLError,
  LinearHttpError,
  type LinearClient,
} from "./graphql";
import { isRecord, readNumber, readString } from "./read";
import { findingIssueState } from "./finding-issues";

export type LinearLinkableIssue = {
  id: string;
  identifier: string;
  url: string | null;
  teamId: string;
  state: "open" | "closed";
};

const QUERY = `query PawsImprovementIssue($id: String!) {
  issue(id: $id) { id identifier url team { id } state { type } }
}`;

const CLOSED = new Set(["completed", "canceled"]);

export function createLinearImprovementIssueLookup(client: LinearClient) {
  return async (issue: string, signal?: AbortSignal): Promise<LinearLinkableIssue | null> => {
    const data = await client.query(QUERY, { id: issue }, signal ? { signal } : undefined);
    const node = isRecord(data) ? data["issue"] : null;
    if (!isRecord(node)) return null;
    const team = node["team"];
    const state = node["state"];
    const id = readString(node, "id");
    const identifier = readString(node, "identifier");
    const teamId = isRecord(team) ? readString(team, "id") : null;
    if (!id || !identifier || !teamId) throw new Error("Linear returned an incomplete issue.");
    return {
      id,
      identifier,
      url: readString(node, "url"),
      teamId,
      state: isRecord(state) && CLOSED.has(readString(state, "type") ?? "") ? "closed" : "open",
    };
  };
}

export type ImprovementLinearFailure = {
  ok: false;
  failure: "rate_limited" | "unauthorized" | "unavailable" | "unknown";
  retryAfterMs?: number;
  message: string;
};
export type ImprovementLinearResult<T> = { ok: true; value: T } | ImprovementLinearFailure;
export type ImprovementLinearIssue = LinearLinkableIssue & {
  stateType?: string;
  delegated: boolean;
  description?: string | null;
};
export type ImprovementLinearComment = { id: string; issueId: string };

export type ImprovementLinear = {
  findIssue(id: string): Promise<ImprovementLinearResult<ImprovementLinearIssue | null>>;
  createIssue(input: {
    id: string;
    teamId: string;
    title: string;
    description: string;
    label: string;
  }): Promise<ImprovementLinearResult<ImprovementLinearIssue>>;
  findComment(id: string): Promise<ImprovementLinearResult<ImprovementLinearComment | null>>;
  createComment(input: {
    id: string;
    issueId: string;
    body: string;
  }): Promise<ImprovementLinearResult<ImprovementLinearComment>>;
};

const ISSUE_FIELDS = "id identifier url description team { id } state { type } delegate { id }";

function classify(error: unknown, phase: "read" | "write"): ImprovementLinearFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof LinearRateLimitError)
    return { ok: false, failure: "rate_limited", retryAfterMs: error.retryAfterMs, message };
  if (error instanceof LinearHttpError && error.status === 429)
    return {
      ok: false,
      failure: "rate_limited",
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      message,
    };
  if (
    (error instanceof LinearHttpError && (error.status === 401 || error.status === 403)) ||
    (error instanceof LinearGraphQLError &&
      error.codes.length > 0 &&
      error.codes.every((code) =>
        ["UNAUTHENTICATED", "FORBIDDEN", "PERMISSION_DENIED"].includes(code),
      ))
  )
    return { ok: false, failure: "unauthorized", message };
  if (error instanceof LinearGraphQLError && error.codes.includes("RATELIMITED"))
    return { ok: false, failure: "rate_limited", message };
  return { ok: false, failure: phase === "read" ? "unavailable" : "unknown", message };
}

function issueFrom(node: unknown): ImprovementLinearIssue | null {
  if (!isRecord(node)) return null;
  const id = readString(node, "id");
  const identifier = readString(node, "identifier");
  const team = node["team"];
  const teamId = isRecord(team) ? readString(team, "id") : null;
  if (!id || !identifier || !teamId) return null;
  const state = node["state"];
  return {
    id,
    identifier,
    url: readString(node, "url"),
    teamId,
    state: isRecord(state) && CLOSED.has(readString(state, "type") ?? "") ? "closed" : "open",
    ...(isRecord(state) && readString(state, "type")
      ? { stateType: readString(state, "type")! }
      : {}),
    delegated: isRecord(node["delegate"]),
    description: readString(node, "description"),
  };
}

function dig(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function nodes(value: unknown): unknown[] {
  const list = dig(value, "nodes");
  return Array.isArray(list) ? list : [];
}

export function createLinearImprovementDelivery(client: LinearClient): ImprovementLinear {
  async function read<T>(run: () => Promise<T>): Promise<ImprovementLinearResult<T>> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return classify(error, "read");
    }
  }
  return {
    findIssue: (id) =>
      read(async () => {
        const data = await client.query(
          `query PawsImprovementFiled($id: ID!) { issues(first: 1, filter: { id: { eq: $id } }) { nodes { ${ISSUE_FIELDS} } } }`,
          { id },
        );
        const found = nodes(dig(data, "issues"))
          .map(issueFrom)
          .find((issue) => issue?.id === id);
        return found ?? null;
      }),
    async createIssue(input) {
      const prepared = await read(async () => {
        const data = await client.query(
          `query PawsImprovementTeam($id: String!, $name: String!) {
              team(id: $id) { states(first: 100) { nodes { id type position } } }
              issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) {
                nodes { id isGroup team { id } }
              }
            }`,
          { id: input.teamId, name: input.label },
        );
        const team = dig(data, "team");
        if (!isRecord(team)) throw new LinearEntityNotFoundError(`Entity not found: Team`);
        const stateId = findingIssueState(
          nodes(dig(team, "states"))
            .filter(isRecord)
            .flatMap((state) => {
              const id = readString(state, "id");
              const type = readString(state, "type");
              return id && type ? [{ id, type, position: readNumber(state, "position") ?? 0 }] : [];
            }),
        );
        const labels = nodes(dig(data, "issueLabels"))
          .filter(isRecord)
          .filter((label) => label["isGroup"] !== true)
          .map((label) => ({
            id: readString(label, "id"),
            team: isRecord(label["team"]) ? readString(label["team"], "id") : null,
          }));
        let labelId =
          (
            labels.find((label) => label.team === input.teamId) ??
            labels.find((label) => label.team === null)
          )?.id ?? null;
        if (!labelId) {
          const created = dig(
            await client.query(
              `mutation PawsImprovementLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }`,
              { input: { name: input.label, teamId: input.teamId } },
            ),
            "issueLabelCreate",
          );
          labelId = readString((dig(created, "issueLabel") as Record<string, unknown>) ?? {}, "id");
          if (dig(created, "success") !== true || !labelId)
            throw new Error(`Linear did not create the "${input.label}" label`);
        }
        return { stateId, labelId };
      });
      if (!prepared.ok) return prepared;
      try {
        const created = dig(
          await client.query(
            `mutation PawsImprovementIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
            {
              input: {
                id: input.id,
                teamId: input.teamId,
                title: input.title,
                description: input.description,
                labelIds: [prepared.value.labelId],
                ...(prepared.value.stateId ? { stateId: prepared.value.stateId } : {}),
                delegateId: null,
              },
            },
          ),
          "issueCreate",
        );
        const issue = issueFrom(dig(created, "issue"));
        if (dig(created, "success") !== true || issue?.id !== input.id)
          return { ok: false, failure: "unknown", message: "Linear returned no created issue" };
        return { ok: true, value: issue };
      } catch (error) {
        return classify(error, "write");
      }
    },
    findComment: (id) =>
      read(async () => {
        const data = await client.query(
          `query PawsImprovementComment($id: ID!) { comments(first: 1, filter: { id: { eq: $id } }) { nodes { id issue { id } } } }`,
          { id },
        );
        const node = nodes(dig(data, "comments"))
          .filter(isRecord)
          .find((entry) => entry["id"] === id);
        const issue = node ? dig(node, "issue") : null;
        const issueId = isRecord(issue) ? readString(issue, "id") : null;
        return node && issueId ? { id, issueId } : null;
      }),
    async createComment(input) {
      try {
        const created = dig(
          await client.query(
            `mutation PawsImprovementEvidence($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
            { input: { id: input.id, issueId: input.issueId, body: input.body } },
          ),
          "commentCreate",
        );
        if (dig(created, "success") !== true || dig(dig(created, "comment"), "id") !== input.id)
          return { ok: false, failure: "unknown", message: "Linear returned no created comment" };
        return { ok: true, value: { id: input.id, issueId: input.issueId } };
      } catch (error) {
        return classify(error, "write");
      }
    },
  };
}

export function createFakeImprovementLinear(seed: { issues?: ImprovementLinearIssue[] } = {}) {
  type Method = keyof ImprovementLinear;
  const issues = new Map<string, ImprovementLinearIssue>(
    (seed.issues ?? []).map((issue) => [issue.id, issue]),
  );
  const comments = new Map<string, ImprovementLinearComment & { body: string }>();
  const created: Parameters<ImprovementLinear["createIssue"]>[0][] = [];
  const calls: { method: Method; id: string }[] = [];
  const queued: { method: Method; outcome: ImprovementLinearFailure | "lose" }[] = [];
  let count = 0;
  const next = (method: Method) => {
    const index = queued.findIndex((entry) => entry.method === method);
    return index === -1 ? null : queued.splice(index, 1)[0]!.outcome;
  };
  const fake: ImprovementLinear = {
    async findIssue(id) {
      calls.push({ method: "findIssue", id });
      const outcome = next("findIssue");
      if (outcome && outcome !== "lose") return outcome;
      return { ok: true, value: issues.get(id) ?? null };
    },
    async createIssue(input) {
      calls.push({ method: "createIssue", id: input.id });
      const outcome = next("createIssue");
      if (outcome && outcome !== "lose") return outcome;
      if (issues.has(input.id))
        return { ok: false, failure: "unknown", message: "Linear: id already exists" };
      count += 1;
      const issue: ImprovementLinearIssue = {
        id: input.id,
        identifier: `IMP-${count}`,
        url: `https://linear.app/fake/issue/IMP-${count}`,
        teamId: input.teamId,
        state: "open",
        delegated: false,
        description: input.description,
      };
      issues.set(input.id, issue);
      created.push(input);
      if (outcome === "lose") return { ok: false, failure: "unknown", message: "socket closed" };
      return { ok: true, value: issue };
    },
    async findComment(id) {
      calls.push({ method: "findComment", id });
      const outcome = next("findComment");
      if (outcome && outcome !== "lose") return outcome;
      const comment = comments.get(id);
      return { ok: true, value: comment ? { id: comment.id, issueId: comment.issueId } : null };
    },
    async createComment(input) {
      calls.push({ method: "createComment", id: input.id });
      const outcome = next("createComment");
      if (outcome && outcome !== "lose") return outcome;
      if (comments.has(input.id))
        return { ok: false, failure: "unknown", message: "Linear: id already exists" };
      comments.set(input.id, { ...input });
      if (outcome === "lose") return { ok: false, failure: "unknown", message: "socket closed" };
      return { ok: true, value: { id: input.id, issueId: input.issueId } };
    },
  };
  return {
    ...fake,
    issues,
    comments,
    created,
    calls,
    fail(method: Method, outcome: ImprovementLinearFailure | "lose") {
      queued.push({ method, outcome });
    },
  };
}
