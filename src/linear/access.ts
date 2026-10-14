import type { TrackerRequestOptions } from "./adapter";
import type { LinearInstallation } from "./administration";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

export type LinearSessionInstallation = LinearInstallation & {
  sessionId: string;
  issueId: string;
  teamId: string;
};

export interface LinearAccessReads {
  installation(options?: TrackerRequestOptions): Promise<LinearInstallation>;
  session(sessionId: string, options?: TrackerRequestOptions): Promise<LinearSessionInstallation>;
  team(teamId: string, options?: TrackerRequestOptions): Promise<boolean>;
  teams?(options?: TrackerRequestOptions): Promise<{ id: string; name: string; key: string }[]>;
}

const VIEWER = `query PawsInstallation {
  viewer { id app organization { id } }
}`;
const SESSION = `query PawsSessionInstallation($id: String!) {
  viewer { id app organization { id } }
  agentSession(id: $id) {
    id appUser { id app organization { id } } issue { id team { id } }
  }
}`;
const TEAM = `query PawsTeamAccess($id: String!) { team(id: $id) { id } }`;

export function createLinearAccessReads(
  client: LinearClient,
  oauthClientId: string | null,
): LinearAccessReads {
  function installation(data: unknown): LinearInstallation {
    if (oauthClientId === null || oauthClientId.trim() === "")
      throw new Error("The Linear OAuth client must be configured before running agent sessions.");
    const viewer = child(data, "viewer");
    if (viewer?.["app"] !== true)
      throw new Error("Linear agent sessions require an app credential.");
    return {
      oauthClientId,
      appUserId: required(viewer, "id"),
      organizationId: required(child(viewer, "organization"), "id"),
    };
  }
  return {
    async installation(options) {
      const data = await client.query(VIEWER, undefined, options);
      options?.signal?.throwIfAborted();
      return installation(data);
    },
    async session(sessionId, options) {
      const data = await client.query(SESSION, { id: sessionId }, options);
      options?.signal?.throwIfAborted();
      const scope = installation(data);
      const session = child(data, "agentSession");
      const app = child(session, "appUser");
      if (
        required(session, "id") !== sessionId ||
        required(app, "id") !== scope.appUserId ||
        app?.["app"] !== true ||
        required(child(app, "organization"), "id") !== scope.organizationId
      )
        throw new Error("The Linear agent session belongs to another installation.");
      const issue = child(session, "issue");
      return {
        ...scope,
        sessionId,
        issueId: required(issue, "id"),
        teamId: required(child(issue, "team"), "id"),
      };
    },
    async teams(options) {
      const result: { id: string; name: string; key: string }[] = [];
      const cursors = new Set<string>();
      const ids = new Set<string>();
      const scope = await this.installation(options);
      let after: string | null = null;
      for (let page = 0; page < 100; page++) {
        const data = await client.query(
          `query PawsRepositoryTeams($after: String) {
          viewer { id app organization { id } }
          teams(first: 100, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } }
        }`,
          { after },
          options,
        );
        options?.signal?.throwIfAborted();
        if (JSON.stringify(installation(data)) !== JSON.stringify(scope))
          throw new Error("Linear installation changed.");
        const teams = child(data, "teams");
        const info = child(teams, "pageInfo");
        if (!Array.isArray(teams?.["nodes"]) || typeof info?.["hasNextPage"] !== "boolean")
          throw new Error("Linear teams are incomplete.");
        for (const team of teams["nodes"]) {
          const id = required(team, "id");
          if (ids.has(id)) throw new Error("Linear team pagination repeated a team.");
          ids.add(id);
          result.push({
            id: required(team, "id"),
            name: required(team, "name"),
            key: required(team, "key"),
          });
        }
        if (!info["hasNextPage"]) return result;
        const cursor = required(info, "endCursor");
        if (cursors.has(cursor)) throw new Error("Linear team pagination did not advance.");
        cursors.add(cursor);
        after = cursor;
      }
      throw new Error("Linear team pagination exceeded its limit.");
    },
    async team(teamId, options) {
      const data = await client.query(TEAM, { id: teamId }, options);
      options?.signal?.throwIfAborted();
      if (isRecord(data) && data["team"] === null) return false;
      const team = child(data, "team");
      if (required(team, "id") !== teamId)
        throw new Error("Linear returned another team during access verification.");
      return true;
    },
  };
}

function child(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function required(value: Record<string, unknown> | null, key: string): string {
  const text = value === null ? null : readString(value, key);
  if (text === null || text.trim() === "")
    throw new Error("Linear returned incomplete installation access.");
  return text;
}
