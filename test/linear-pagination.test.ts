import { describe, expect, test } from "bun:test";
import { createInboxStore, createIntakePollSource, startCatchUpPoller } from "../src/linear";
import type { LinearClient } from "../src/linear";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;

describe("Linear session pagination", () => {
  test("discovers a session beyond the first 50 within one pass and then advances the cursor", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const seen: string[] = [];
    let calls = 0;
    const client: LinearClient = {
      async query(query, variables = {}) {
        expect(query).toContain("after: $sessionAfter");
        expect(query).toContain("@include(if: $includeSessions)");
        calls += 1;
        if (calls === 1) {
          expect(variables["sessionAfter"]).toBeNull();
          return {
            ...page(),
            agentSessions: connection(
              Array.from({ length: 50 }, (_, index) => ({
                ...session(`other-${index}`, "issue-other", NOW),
                appUser: { id: "other-app" },
              })),
              "session-page-2",
            ),
          };
        }
        expect(variables["sessionAfter"]).toBe("session-page-2");
        expect(variables["includeIssues"]).toBe(false);
        return {
          viewer: { id: "app" },
          agentSessions: connection([session("ours", "issue", NOW)]),
        };
      },
    };
    const poller = startCatchUpPoller({
      source: createIntakePollSource(client, { teamId: "ENG" }),
      store,
      onEvent(event) {
        if (event.sessionId !== null) seen.push(event.sessionId);
      },
      now: () => NOW,
    });
    try {
      await until(() => store.getCursor("linear") !== null);
      expect(calls).toBe(2);
      expect(seen).toEqual(["ours"]);
      expect(store.getCursor("linear")).toBe(NOW);
    } finally {
      await poller.stop();
      db.close();
    }
  });

  test("pages sessions newest first and stops at the first one older than the cursor", async () => {
    const variables: Record<string, unknown>[] = [];
    const client: LinearClient = {
      async query(query, input = {}) {
        expect(query).toContain("orderBy: updatedAt, includeArchived: true");
        variables.push(input);
        return {
          ...page(),
          agentSessions: connection(
            [
              {
                ...session("fresh", "issue", NOW - 120_000),
                updatedAt: new Date(NOW + 1_000).toISOString(),
              },
              session("stale", "issue", NOW - 60_000),
            ],
            "older-sessions",
          ),
        };
      },
    };
    const result = await createIntakePollSource(client, { teamId: "ENG" }).poll(NOW);
    expect(result.caughtUp).toBe(true);
    expect(variables).toHaveLength(1);
    expect(result.sessions.map(({ id }) => id)).toEqual(["fresh", "stale"]);
  });

  test("keeps every eligible session across pages with different connection lengths", async () => {
    let calls = 0;
    const client: LinearClient = {
      async query(_query, variables = {}) {
        calls += 1;
        if (calls === 1) {
          return {
            ...page(),
            issues: connection([], "issues-2"),
            agentSessions: connection([session("new", "issue", NOW)], "sessions-2"),
          };
        }
        expect(variables["since"]).toBe(new Date(NOW).toISOString());
        expect(variables["includeComments"]).toBe(false);
        if (calls === 2) {
          return {
            viewer: { id: "app" },
            issues: connection([], "issues-3"),
            agentSessions: connection([session("old", "issue", NOW - 1_000)]),
          };
        }
        expect(variables["includeSessions"]).toBe(false);
        return { viewer: { id: "app" }, issues: connection([]) };
      },
    };
    const source = createIntakePollSource(client, { teamId: "ENG" });
    expect((await source.poll(NOW)).caughtUp).toBe(false);
    const second = await source.poll(NOW + 1_000);
    expect(second.caughtUp).toBe(false);
    expect(second.sessions.map(({ id }) => id)).toEqual(["new", "old"]);
    expect((await source.poll(NOW + 2_000)).caughtUp).toBe(true);
  });

  test.each([null, "page-2"])(
    "does not consume other connections when a session cursor is invalid: %s",
    async (invalid) => {
      let calls = 0;
      const client: LinearClient = {
        async query(_query, variables = {}) {
          calls += 1;
          if (calls === 1) return { ...page(), agentSessions: connection([], "page-2") };
          expect(variables["sessionAfter"]).toBe("page-2");
          expect(variables["includeIssues"]).toBe(false);
          if (calls === 2) {
            return {
              viewer: { id: "app" },
              agentSessions: { nodes: [], pageInfo: { hasNextPage: true, endCursor: invalid } },
            };
          }
          return {
            viewer: { id: "app" },
            agentSessions: connection([session("ours", "issue", NOW)]),
          };
        },
      };
      const source = createIntakePollSource(client, { teamId: "ENG" });
      await source.poll(NOW);
      await expect(source.poll(NOW)).rejects.toThrow("pagination did not advance");
      expect((await source.poll(NOW)).sessions.map(({ id }) => id)).toEqual(["ours"]);
    },
  );

  test("retries the same cursor after a transport failure and starts a fresh scan after completion", async () => {
    let calls = 0;
    const client: LinearClient = {
      async query(_query, variables = {}) {
        calls += 1;
        if (calls === 1) return { ...page(), agentSessions: connection([], "page-2") };
        if (calls === 2) throw new Error("transport unavailable");
        if (calls === 3) {
          expect(variables["sessionAfter"]).toBe("page-2");
          expect(variables["since"]).toBe(new Date(NOW).toISOString());
          return {
            viewer: { id: "app" },
            agentSessions: connection([session("ours", "issue", NOW)]),
          };
        }
        expect(variables["sessionAfter"]).toBeNull();
        expect(variables["includeSessions"]).toBe(true);
        expect(variables["includeIssues"]).toBe(true);
        expect(variables["since"]).toBe(new Date(NOW + 5_000).toISOString());
        return page();
      },
    };
    const source = createIntakePollSource(client, { teamId: "ENG" });
    await source.poll(NOW);
    await expect(source.poll(NOW + 1_000)).rejects.toThrow("transport unavailable");
    expect((await source.poll(NOW + 2_000)).caughtUp).toBe(true);
    const fresh = await source.poll(NOW + 5_000);
    expect(fresh.caughtUp).toBe(true);
    expect(fresh.sessions).toEqual([]);
  });
});

function page() {
  return {
    viewer: { id: "app" },
    issues: connection([]),
    comments: connection([]),
    agentActivities: connection([]),
    agentSessions: connection([]),
  };
}

function connection(nodes: unknown[], cursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } };
}

function session(id: string, issue: string, created: number) {
  return {
    id,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(created).toISOString(),
    appUser: { id: "app" },
    issue: { id: issue, team: { id: "team", key: "ENG" } },
  };
}

async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) {
      await Bun.sleep(1);
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("poll did not start");
}
