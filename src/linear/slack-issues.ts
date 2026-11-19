import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";
import { stableUuid } from "./sub-issues";

export type SlackIssueTeam = { id: string; key: string; name: string; private: boolean };

export type SlackIssueRequest = Record<"key" | "teamId" | "title" | "description", string>;

export type FiledSlackIssue = { id: string; identifier: string; url: string | null };

export const slackIssueId = (key: string) => stableUuid(`paws:slack-issue:${key}`);

const TEAM = `query SlackIssueTeam($key: String!) {
  teams(first: 2, filter: { key: { eqIgnoreCase: $key } }) { nodes { id key name private } }
}`;

const EXISTING = `query SlackIssueFiled($ids: [ID!]!) {
  viewer { id }
  issues(first: 1, filter: { id: { in: $ids } }) { nodes { id identifier url team { id } } }
}`;

const CREATE = `mutation SlackIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

export function createLinearSlackIssueMethods(client: LinearClient) {
  return {
    async slackIssueTeam(
      key: string,
      options?: TrackerRequestOptions,
    ): Promise<SlackIssueTeam | null> {
      const data = await client.query(TEAM, { key }, options);
      const teams = nodes(dig(data, "teams")).filter(isRecord);
      const team = teams.length === 1 ? teams[0]! : null;
      const id = team && readString(team, "id");
      const found = team && readString(team, "key");
      if (!team || !id || !found || typeof team["private"] !== "boolean") return null;
      return { id, key: found, name: readString(team, "name") ?? found, private: team["private"] };
    },

    async fileSlackIssue(
      request: SlackIssueRequest,
      options?: TrackerRequestOptions,
    ): Promise<FiledSlackIssue> {
      if (!request.key.trim() || !request.teamId.trim() || !request.title.trim())
        throw new Error("A Slack issue needs a key, a team and a title");
      options?.signal?.throwIfAborted();
      const id = slackIssueId(request.key);
      const data = await client.query(EXISTING, { ids: [id] }, options);
      const viewer = dig(data, "viewer");
      const delegateId = isRecord(viewer) ? readString(viewer, "id") : null;
      let issue = nodes(dig(data, "issues"))
        .filter(isRecord)
        .find((node) => node["id"] === id);
      if (issue) {
        const team = dig(issue, "team");
        if (!isRecord(team) || team["id"] !== request.teamId)
          throw new Error("The Slack issue exists in another team");
      } else {
        if (!delegateId) throw new Error("Linear returned no app user to delegate the issue to");
        const input = {
          id,
          teamId: request.teamId,
          delegateId,
          title: request.title,
          description: request.description,
        };
        const created = dig(await client.query(CREATE, { input }, options), "issueCreate");
        const value = dig(created, "issue");
        if (!isRecord(created) || created["success"] !== true || !isRecord(value))
          throw new Error("Linear did not create the issue");
        issue = value;
      }
      const identifier = readString(issue, "identifier");
      if (readString(issue, "id") !== id || !identifier)
        throw new Error("Linear returned an unexpected issue");
      return { id, identifier, url: readString(issue, "url") };
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
