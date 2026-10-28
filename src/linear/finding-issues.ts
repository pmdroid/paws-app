import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readNumber, readString } from "./read";
import { stableUuid } from "./sub-issues";

/**
 * File one issue from a review finding next to `relatedIssueId`: in its team and project, in
 * the team's Triage state (Backlog without Triage), with the `review finding` label and a
 * `related` relation. Nothing is delegated. `key` names the finding; the issue and relation
 * ids derive from it, so a retried call finds what an earlier attempt filed.
 */
export type FindingIssueRequest = {
  key: string;
  relatedIssueId: string;
  title: string;
  description: string;
};

export type FiledFindingIssue = { id: string; identifier: string; url: string | null };

/** A team's workflow state, as Linear lists it. */
export type FindingIssueTeamState = { id: string; type: string; position: number };

export const REVIEW_FINDING_LABEL = "review finding";

export const findingIssueId = (key: string) => stableUuid(`paws:finding-issue:${key}`);

/** The team's Triage state, else its first Backlog state. Null when it has neither. */
export function findingIssueState(states: readonly FindingIssueTeamState[]): string | null {
  const ranked = (type: string) =>
    states
      .filter((state) => state.type === type)
      .sort((left, right) => left.position - right.position)[0]?.id ?? null;
  return ranked("triage") ?? ranked("backlog");
}

export function validateFindingIssueRequest(request: FindingIssueRequest): void {
  if (!request.key.trim() || !request.relatedIssueId.trim())
    throw new Error("A finding issue needs a key and a related issue");
  if (!request.title.trim()) throw new Error("A finding issue needs a title");
}

const TARGET = `query FindingIssueTarget($id: String!, $ids: [ID!]!) {
  issue(id: $id) {
    id
    team { id states(first: 100) { nodes { id type position } } }
    project { id }
  }
  issues(first: 1, filter: { id: { in: $ids } }) {
    nodes { id identifier url relations(first: 50) { nodes { type relatedIssue { id } } } }
  }
}`;

const LABELS = `query FindingIssueLabels($name: String!) {
  issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) {
    nodes { id isGroup team { id } }
  }
}`;

const CREATE_LABEL = `mutation FindingIssueLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id } }
}`;

const CREATE = `mutation FindingIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

const RELATE = `mutation FindingIssueRelated($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

export function createLinearFindingIssueMethods(client: LinearClient) {
  return {
    async fileFindingIssue(
      request: FindingIssueRequest,
      options?: TrackerRequestOptions,
    ): Promise<FiledFindingIssue> {
      validateFindingIssueRequest(request);
      options?.signal?.throwIfAborted();
      const id = findingIssueId(request.key);
      const target = await client.query(TARGET, { id: request.relatedIssueId, ids: [id] }, options);
      const related = dig(target, "issue");
      const relatedId = isRecord(related) ? readString(related, "id") : null;
      const team = dig(related, "team");
      const teamId = isRecord(team) ? readString(team, "id") : null;
      if (!relatedId || !teamId) throw new Error("Linear returned no issue to file the finding by");
      let issue = nodes(dig(target, "issues"))
        .filter(isRecord)
        .find((node) => node["id"] === id);
      if (!issue) {
        const project = dig(related, "project");
        const projectId = isRecord(project) ? readString(project, "id") : null;
        const stateId = findingIssueState(
          nodes(dig(team, "states"))
            .filter(isRecord)
            .flatMap((state) => {
              const stateId = readString(state, "id");
              const type = readString(state, "type");
              return stateId && type
                ? [{ id: stateId, type, position: readNumber(state, "position") ?? 0 }]
                : [];
            }),
        );
        const labelId = await findingLabel(teamId);
        const created = dig(
          await client.query(
            CREATE,
            {
              input: {
                id,
                teamId,
                ...(projectId ? { projectId } : {}),
                ...(stateId ? { stateId } : {}),
                labelIds: [labelId],
                title: request.title,
                description: request.description,
              },
            },
            options,
          ),
          "issueCreate",
        );
        const value = dig(created, "issue");
        if (!isRecord(created) || created["success"] !== true || !isRecord(value))
          throw new Error("Linear did not create the issue");
        issue = value;
      }
      const identifier = readString(issue, "identifier");
      if (readString(issue, "id") !== id || !identifier)
        throw new Error("Linear returned an unexpected issue");
      const linked = nodes(dig(issue, "relations"))
        .filter(isRecord)
        .some(
          (relation) =>
            relation["type"] === "related" &&
            isRecord(relation["relatedIssue"]) &&
            relation["relatedIssue"]["id"] === relatedId,
        );
      if (!linked) {
        options?.signal?.throwIfAborted();
        const relation = dig(
          await client.query(
            RELATE,
            {
              input: {
                id: stableUuid(`paws:finding-issue-related:${request.key}`),
                type: "related",
                issueId: id,
                relatedIssueId: relatedId,
              },
            },
            options,
          ),
          "issueRelationCreate",
        );
        if (!isRecord(relation) || relation["success"] !== true)
          throw new Error(`Linear did not relate ${identifier} to the issue`);
      }
      return { id, identifier, url: readString(issue, "url") };

      /** The team's or the workspace's `review finding` label, created in the team when missing. */
      async function findingLabel(teamId: string): Promise<string> {
        const found = nodes(
          dig(await client.query(LABELS, { name: REVIEW_FINDING_LABEL }, options), "issueLabels"),
        )
          .filter(isRecord)
          .filter((label) => label["isGroup"] !== true)
          .map((label) => ({
            id: readString(label, "id"),
            team: isRecord(label["team"]) ? readString(label["team"], "id") : null,
          }));
        const label =
          found.find((entry) => entry.team === teamId) ??
          found.find((entry) => entry.team === null);
        if (label?.id) return label.id;
        const created = dig(
          await client.query(
            CREATE_LABEL,
            { input: { name: REVIEW_FINDING_LABEL, teamId } },
            options,
          ),
          "issueLabelCreate",
        );
        const value = dig(created, "issueLabel");
        const labelId = isRecord(value) ? readString(value, "id") : null;
        if (!isRecord(created) || created["success"] !== true || !labelId)
          throw new Error(`Linear did not create the "${REVIEW_FINDING_LABEL}" label`);
        return labelId;
      }
    },
  };
}

function dig(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function nodes(value: unknown): unknown[] {
  const list = dig(value, "nodes");
  return Array.isArray(list) ? list : [];
}
