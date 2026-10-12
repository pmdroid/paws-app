import type { LinearClient } from "./graphql";
import { isRecord } from "./read";

export type LinearMemberIdentity = {
  userId: string;
  organizationId: string;
  active: boolean;
  guest: boolean;
  admin: boolean;
  teamIds: readonly string[];
};

export interface LinearMembershipReads {
  member(
    organizationId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<LinearMemberIdentity>;
}

const MEMBER_QUERY = `query PawsBrowserMembership($id: String!, $after: String) {
  viewer { app organization { id } }
  user(id: $id) {
    id active guest admin organization { id }
    teams(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
  }
}`;

export function createLinearMembershipReads(client: LinearClient): LinearMembershipReads {
  return {
    async member(organizationId, userId, signal) {
      const teamIds = new Set<string>();
      const cursors = new Set<string>();
      let after: string | null = null;
      let identity: Omit<LinearMemberIdentity, "teamIds"> | null = null;
      for (let page = 0; page < 100; page++) {
        const data = await client.query(MEMBER_QUERY, { id: userId, after }, { signal });
        signal?.throwIfAborted();
        const viewer = field(data, "viewer");
        const user = field(data, "user");
        if (
          viewer?.["app"] !== true ||
          field(viewer, "organization")?.["id"] !== organizationId ||
          user?.["id"] !== userId ||
          field(user, "organization")?.["id"] !== organizationId ||
          typeof user["active"] !== "boolean" ||
          typeof user["guest"] !== "boolean" ||
          typeof user["admin"] !== "boolean"
        )
          throw new Error("Linear membership could not be verified.");
        const next = {
          userId,
          organizationId,
          active: user["active"],
          guest: user["guest"],
          admin: user["admin"],
        };
        if (identity !== null && JSON.stringify(identity) !== JSON.stringify(next))
          throw new Error("Linear membership changed during verification.");
        identity = next;
        const teams = field(user, "teams");
        const info = field(teams, "pageInfo");
        if (!Array.isArray(teams?.["nodes"]) || typeof info?.["hasNextPage"] !== "boolean")
          throw new Error("Linear returned incomplete team membership.");
        for (const team of teams["nodes"]) {
          if (!isRecord(team) || typeof team["id"] !== "string" || team["id"].trim() === "")
            throw new Error("Linear returned invalid team membership.");
          teamIds.add(team["id"]);
        }
        if (!info["hasNextPage"]) return { ...identity, teamIds: [...teamIds].sort() };
        const cursor = info["endCursor"];
        if (typeof cursor !== "string" || cursor === "" || cursors.has(cursor))
          throw new Error("Linear membership pagination did not advance.");
        cursors.add(cursor);
        after = cursor;
      }
      throw new Error("Linear membership pagination exceeded its limit.");
    },
  };
}

function field(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}
