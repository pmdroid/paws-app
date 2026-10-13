import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLinearClient,
  createLinearTracker,
  createLinearIssueLifecycle,
} from "../../src/linear";

export async function probeLinearProjectMembers(
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  let scenario = "complete";
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      if (body.query.includes("IssueOwnership")) {
        assert.match(body.query, /project \{ id \}/);
        return Response.json({
          data: {
            issue: {
              id: "issue",
              team: { id: "team" },
              state: { type: "started" },
              assignee: null,
              delegate: { id: "app" },
              project: scenario === "unprojected" ? null : { id: "project" },
            },
          },
        });
      }
      assert.match(body.query, /members\(first: 50, after: \$after\)/);
      const next = body.variables["after"] !== null;
      const members =
        scenario === "malformed"
          ? [{ id: "" }]
          : next
            ? [{ id: "second" }, { id: "first" }]
            : [{ id: "first" }];
      return Response.json({
        data: {
          project: {
            id: scenario === "wrong-project" ? "other" : "project",
            members: {
              nodes: members,
              pageInfo: { hasNextPage: scenario === "loop" || !next, endCursor: "next" },
            },
          },
        },
      });
    },
  });
  const client = createLinearClient({
    auth: {
      hasToken: () => true,
      ensureFresh: async () => "fixture",
      forceRefresh: async () => "fixture",
    },
    fetch(input, init) {
      assert.equal(String(input), "https://api.linear.app/graphql");
      return fetch(`http://127.0.0.1:${server.port}/graphql`, init);
    },
  });
  const tracker = createLinearTracker(client);
  try {
    assert.deepEqual(await tracker.listProjectMembers!("project"), ["first", "second"]);
    assert.equal(requests.length, 2);
    observe("Project members use complete real HTTP pagination and deduplicate identities", true, {
      pages: requests.length,
    });
    const lifecycle = createLinearIssueLifecycle(client);
    assert.equal((await lifecycle.inspect("issue")).projectId, "project");
    scenario = "unprojected";
    assert.equal((await lifecycle.inspect("issue")).projectId, null);
    observe("Fresh issue ownership distinguishes a project from explicit unprojected state", true, {
      project: "project",
      unprojected: null,
    });
    for (const fault of ["malformed", "loop", "wrong-project"]) {
      scenario = fault;
      await assert.rejects(() => tracker.listProjectMembers!("project"), /project/i);
    }
    observe("Incomplete identities, cursor cycles and changed project reject shared access", true, {
      rejected: 3,
    });
    const before = requests.length;
    await assert.rejects(() =>
      tracker.listProjectMembers!("project", { signal: AbortSignal.abort() }),
    );
    assert.equal(requests.length, before);
    observe("Aborted project membership checks issue no requests", true, {
      unchangedRequests: before,
    });
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  const observations: unknown[] = [];
  await probeLinearProjectMembers((name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
}
