import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinearClient, createLinearTracker } from "../../src/linear";

export async function probeLinearSchedulingMetadata(
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  let scenario = "complete";
  let malformed: Record<string, unknown> = {};
  let childFault = false;
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      assert.match(body.query, /team \{ id \}/);
      assert.match(body.query, /project \{ id lead \{ id \} \}/);
      assert.match(body.query, /assignee \{ id \}/);
      assert.match(body.query, /priority/);
      const second = body.variables["after"] !== null;
      const metadata = {
        team: { id: "team" },
        project: scenario === "unassigned" ? null : { id: "project" },
        assignee: scenario === "unassigned" ? null : { id: "assignee" },
        priority: scenario === "unassigned" ? 0 : 2,
      };
      const child = {
        id: second ? "child-2" : "child-1",
        identifier: second ? "ENG-3" : "ENG-2",
        title: "Child",
        description: "paths: src/export",
        ...metadata,
        assignee: scenario === "unassigned" ? null : { id: "child-assignee" },
        ...(childFault ? malformed : {}),
      };
      const issue = {
        id: "parent",
        identifier: "ENG-1",
        title: "Parent",
        description: null,
        ...metadata,
        ...(!childFault ? malformed : {}),
        ...(scenario === "changed" && second ? { assignee: { id: "replacement" } } : {}),
        children: {
          nodes: [child],
          pageInfo: { hasNextPage: !second, endCursor: second ? null : "next" },
        },
      };
      return Response.json({ data: { issue } });
    },
  });
  const tracker = createLinearTracker(
    createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: async () => "fixture",
        forceRefresh: async () => "fixture",
      },
      fetch(input, init) {
        assert.equal(String(input), "https://api.linear.app/graphql");
        return fetch(`http://127.0.0.1:${server.port}/graphql`, init);
      },
    }),
  );
  try {
    const epic = await tracker.loadEpic("parent");
    assert.equal(epic.projectId, "project");
    assert.equal(epic.teamId, "team");
    assert.equal(epic.assigneeId, "assignee");
    assert.equal(epic.priority, 2);
    assert.equal(epic.subIssues.length, 2);
    assert(epic.subIssues.every((item) => item.assigneeId === "child-assignee"));
    assert(epic.subIssues.every((item) => item.projectId === "project" && item.teamId === "team"));
    observe("Real HTTP pagination preserves canonical project, team, assignee and priority", true, {
      pages: requests.length,
      parent: epic.assigneeId,
      children: epic.subIssues.map((item) => item.assigneeId),
    });
    scenario = "unassigned";
    const unassigned = await tracker.loadEpic("parent");
    assert.equal(unassigned.assigneeId, null);
    assert.equal(unassigned.projectId, null);
    assert.equal(unassigned.priority, 0);
    assert(
      unassigned.subIssues.every((item) => item.assigneeId === null && item.projectId === null),
    );
    observe("Explicit unassigned and unprojected issues retain null metadata", true, unassigned);
    scenario = "changed";
    await assert.rejects(() => tracker.loadEpic("parent"), /scheduling changed/);
    observe("Changed canonical metadata between pages rejects the complete snapshot", true, {
      changed: "assignee",
    });
    scenario = "complete";
    const faults = [
      { team: null },
      { project: { id: "" } },
      { assignee: { id: 7 } },
      { priority: 5 },
      { priority: -1 },
      { priority: 1.5 },
    ];
    for (const child of [false, true]) {
      childFault = child;
      for (const fault of faults) {
        malformed = fault;
        await assert.rejects(() => tracker.loadEpic("parent"), /scheduling/);
      }
      observe("Malformed scheduling metadata rejects " + (child ? "children" : "parents"), true, {
        rejectedCases: faults.length,
      });
    }
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  const observations: unknown[] = [];
  try {
    await probeLinearSchedulingMetadata((name, passed, observed) =>
      observations.push({ name, passed, observed }),
    );
  } finally {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  }
}
