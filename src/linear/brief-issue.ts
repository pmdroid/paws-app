import type { IssueBrief } from "../core";
import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

export type BriefIssueRead = {
  issue: IssueBrief;
  parent: IssueBrief | null;
  projectOverview: string;
};

const QUERY = `query BriefPreview($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    project { name content }
    parent { id identifier title description }
  }
}`;

/** One Linear read of an issue and its parent. No pagination and no second request. */
export async function readLinearBriefIssue(
  client: LinearClient,
  identifier: string,
  options?: TrackerRequestOptions,
): Promise<BriefIssueRead | null> {
  const data = await client.query(QUERY, { id: identifier }, options);
  return briefIssueFromQuery(data);
}

export function briefIssueFromQuery(data: unknown): BriefIssueRead | null {
  const issue = isRecord(data) ? data["issue"] : null;
  if (issue === null) return null;
  if (!isRecord(issue)) throw new Error("Linear returned an invalid issue.");
  const brief = issueBrief(issue);
  if (brief === null) throw new Error("Linear issue snapshot was missing id, identifier, or title");
  const parentRecord = issue["parent"];
  let parent: IssueBrief | null = null;
  if (parentRecord !== null && parentRecord !== undefined) {
    if (!isRecord(parentRecord)) throw new Error("Linear returned an invalid parent issue.");
    parent = issueBrief(parentRecord);
    if (parent === null)
      throw new Error("Linear parent issue was missing id, identifier, or title");
  }
  return { issue: brief, parent, projectOverview: projectOverview(issue["project"]) };
}

function issueBrief(record: Record<string, unknown>): IssueBrief | null {
  const issueId = readString(record, "id");
  const identifier = readString(record, "identifier");
  const title = readString(record, "title");
  if (issueId === null || identifier === null || title === null) return null;
  const description = record["description"];
  return {
    source: "linear",
    issueId,
    identifier,
    title,
    description: typeof description === "string" ? description : null,
    acceptanceCriteria: null,
  };
}

function projectOverview(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (!isRecord(value)) throw new Error("Linear returned an invalid project.");
  const name = readString(value, "name");
  if (name === null) return "";
  const content = value["content"];
  return `Project overview: ${name}\n\n${typeof content === "string" ? content : ""}`;
}
