import { createHash } from "node:crypto";
import { validateSubIssueDrafts, type FiledSubIssue, type SubIssueDraft } from "../core";
import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

/**
 * File `drafts` as sub-issues of `parentIssueId`. `key` names the approval
 * (the question id); issue and relation ids derive from it, so a retried call
 * finds what an earlier attempt filed and creates nothing twice.
 */
export type SubIssueRequest = {
  key: string;
  parentIssueId: string;
  drafts: readonly SubIssueDraft[];
  /** `owner/repo` for the repository label, when the plan ran against a repository. */
  repository?: string | null;
};

const PARENT = `query SubIssueParent($id: String!) {
  issue(id: $id) { id team { id } project { id } }
}`;

const EXISTING = `query SubIssuesFiled($ids: [ID!]!) {
  issues(first: 50, filter: { id: { in: $ids } }) {
    nodes {
      id identifier url parent { id }
      relations(first: 50) { nodes { type relatedIssue { id } } }
    }
  }
}`;

const CREATE = `mutation SubIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

const RELATE = `mutation SubIssueBlocks($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

/** A UUID v4 that is the same for the same seed. */
export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const subIssueId = (key: string, index: number) =>
  stableUuid(`paws:sub-issue:${key}:${index}`);

/** The issue body: the draft's description followed by its acceptance criteria. */
export function subIssueDescription(draft: SubIssueDraft): string {
  return [
    draft.description,
    "## Acceptance criteria",
    draft.acceptanceCriteria.map((line) => `- [ ] ${line}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function validateSubIssueRequest(request: SubIssueRequest): SubIssueDraft[] {
  if (!request.key.trim() || !request.parentIssueId.trim())
    throw new Error("Sub-issues need an approval key and a parent issue");
  return validateSubIssueDrafts(request.drafts);
}

export function createLinearSubIssueMethods(
  client: LinearClient,
  addRepositoryLabel?: (
    input: { issueId: string; repository: string },
    options?: TrackerRequestOptions,
  ) => Promise<void>,
) {
  return {
    async createSubIssues(
      request: SubIssueRequest,
      options?: TrackerRequestOptions,
    ): Promise<FiledSubIssue[]> {
      const drafts = validateSubIssueRequest(request);
      if (request.repository && !addRepositoryLabel)
        throw new Error("Linear repository labels are unavailable");
      options?.signal?.throwIfAborted();
      const parent = dig(
        await client.query(PARENT, { id: request.parentIssueId }, options),
        "issue",
      );
      const parentId = isRecord(parent) ? readString(parent, "id") : null;
      const team = dig(parent, "team");
      const teamId = isRecord(team) ? readString(team, "id") : null;
      if (!isRecord(parent) || !parentId || !teamId)
        throw new Error("Linear returned no parent issue for the sub-issues");
      const project = dig(parent, "project");
      const projectId = isRecord(project) ? readString(project, "id") : null;
      const ids = drafts.map((_, index) => subIssueId(request.key, index));
      const found = new Map<string, Record<string, unknown>>();
      for (const node of nodes(
        dig(await client.query(EXISTING, { ids }, options), "issues"),
      ).filter(isRecord)) {
        const id = readString(node, "id");
        if (id && ids.includes(id)) found.set(id, node);
      }
      const filed: FiledSubIssue[] = [];
      for (const [index, draft] of drafts.entries()) {
        options?.signal?.throwIfAborted();
        const id = ids[index]!;
        let issue = found.get(id);
        if (issue) {
          const owner = dig(issue, "parent");
          if (!isRecord(owner) || owner["id"] !== parentId)
            throw new Error(`Sub-issue ${index + 1} exists under another parent`);
        } else {
          const created = dig(
            await client.query(
              CREATE,
              {
                input: {
                  id,
                  teamId,
                  parentId,
                  ...(projectId ? { projectId } : {}),
                  title: draft.title,
                  description: subIssueDescription(draft),
                },
              },
              options,
            ),
            "issueCreate",
          );
          const value = isRecord(created) ? dig(created, "issue") : null;
          if (!isRecord(created) || created["success"] !== true || !isRecord(value))
            throw new Error(`Linear did not create sub-issue ${index + 1}`);
          issue = value;
        }
        const identifier = readString(issue, "identifier");
        if (readString(issue, "id") !== id || !identifier)
          throw new Error(`Linear returned an unexpected sub-issue ${index + 1}`);
        filed.push({ id, identifier, url: readString(issue, "url") });
      }
      if (request.repository)
        for (const issue of filed)
          await addRepositoryLabel!({ issueId: issue.id, repository: request.repository }, options);
      for (const [index, draft] of drafts.entries())
        for (const blocker of draft.blockedBy) {
          options?.signal?.throwIfAborted();
          const blockerId = ids[blocker]!;
          const blocked = ids[index]!;
          const existing = nodes(dig(found.get(blockerId) ?? {}, "relations"))
            .filter(isRecord)
            .some(
              (relation) =>
                relation["type"] === "blocks" &&
                isRecord(relation["relatedIssue"]) &&
                relation["relatedIssue"]["id"] === blocked,
            );
          if (existing) continue;
          const related = dig(
            await client.query(
              RELATE,
              {
                input: {
                  id: stableUuid(`paws:sub-issue-blocks:${request.key}:${blocker}:${index}`),
                  type: "blocks",
                  issueId: blockerId,
                  relatedIssueId: blocked,
                },
              },
              options,
            ),
            "issueRelationCreate",
          );
          if (!isRecord(related) || related["success"] !== true)
            throw new Error(
              `Linear did not record that sub-issue ${blocker + 1} blocks ${index + 1}`,
            );
        }
      return filed;
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
