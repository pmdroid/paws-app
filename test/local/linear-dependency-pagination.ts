import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLinearClient, createLinearTracker } from "../../src/linear";

export async function probeLinearDependencyPagination(
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  let scenario = "complete";
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const { query, variables } = body as (typeof requests)[number];
      requests.push({ query, variables });
      const children = query.includes("IssueSnapshot");
      assert.match(query, children ? /children\(first: 50/ : /relations\(first: 50/);
      if (!children) assert.match(query, /inverseRelations\(first: 50/);
      const after = variables[children ? "after" : "relationsAfter"];
      const index = after === null ? 0 : Number(after);
      const inverseAfter = variables["inverseAfter"];
      const inverseIndex = inverseAfter === null ? 0 : Number(inverseAfter);
      const relationsLast = scenario === "inverse-first" ? 13 : 11;
      const inverseLast = scenario === "inverse-first" ? 11 : 13;
      let issue: Record<string, unknown> | null = children
        ? {
            id: "parent",
            identifier: "ENG-1",
            title: "Epic",
            children: connection([child(index)], index < 11 ? String(index + 1) : null),
          }
        : {
            id: "parent",
            ...(variables["includeRelations"]
              ? {
                  relations: connection(
                    [edge(index)],
                    index < relationsLast ? String(index + 1) : null,
                  ),
                }
              : {}),
            ...(variables["includeInverse"]
              ? {
                  inverseRelations: connection(
                    [edge(inverseIndex === 0 ? 0 : 100 + inverseIndex)],
                    inverseIndex < inverseLast ? String(inverseIndex + 1) : null,
                  ),
                }
              : {}),
          };
      if (scenario === "transport" && index === 1)
        return new Response("unavailable", { status: 503 });
      if (!["complete", "inverse-first", "transport"].includes(scenario) && index === 1) {
        const field = children ? "children" : "relations";
        if (scenario === "missing-issue") issue = null;
        else if (scenario === "missing-connection") delete issue[field];
        else if (scenario === "missing-identity") delete issue["id"];
        else if (scenario === "changed-identity") issue["id"] = "another-parent";
        else if (scenario === "duplicate-child") issue["children"] = connection([child(0)], null);
        else if (scenario === "bad-node") issue[field] = connection([null], null);
        else if (scenario === "bad-item") issue[field] = connection([{}], null);
        else if (scenario === "missing-page") issue[field] = { nodes: [] };
        else if (scenario === "missing-cursor") issue[field] = connection([], null, true);
        else if (scenario === "repeated-cursor") issue[field] = connection([], "1");
        else if (scenario === "invalid-next")
          issue[field] = { nodes: [], pageInfo: { hasNextPage: 1 } };
      }
      if (scenario === "cap") {
        assert(issue !== null);
        const field = children ? "children" : "relations";
        issue[field] = connection([], String(index + 1));
      }
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
    assert.equal(epic.subIssues.length, 12);
    assert.equal(epic.subIssues[0]?.linearIssueId, "child-11");
    assert.equal(epic.subIssues[11]?.linearIssueId, "child-0");
    assert.equal(requests.length, 12);
    observe("sub-issues beyond ten pages retain sort order over real HTTP", true, {
      pages: requests.length,
      children: epic.subIssues.length,
    });
    requests.length = 0;
    const deps = await tracker.listDeps("parent");
    assert.equal(deps.length, 25);
    assert.equal(requests.length, 14);
    assert.equal(deps.at(-1)?.blockedLinearIssueId, "child-113");
    assert.equal(requests[12]?.variables["includeRelations"], false);
    assert.equal(requests[12]?.variables["includeInverse"], true);
    observe("both relation directions complete without duplicate edges", true, {
      pages: requests.length,
      edges: deps.length,
    });
    assert.deepEqual(await tracker.loadEpic("ENG-1"), epic);
    assert.deepEqual(await tracker.listDeps("ENG-1"), deps);
    observe("identifier aliases pin the returned canonical issue throughout each scan", true, {});
    scenario = "duplicate-child";
    await assert.rejects(tracker.loadEpic("parent"), /repeated a sub-issue/);
    observe("a repeated child identity rejects rather than overwriting an earlier page", true, {});
    scenario = "inverse-first";
    requests.length = 0;
    assert.equal((await tracker.listDeps("parent")).length, 25);
    assert.equal(requests.length, 14);
    assert.equal(requests[12]?.variables["includeRelations"], true);
    assert.equal(requests[12]?.variables["includeInverse"], false);
    observe(
      "completed inverse connections are omitted while forward traversal continues",
      true,
      {},
    );
    for (const invalid of [
      "missing-issue",
      "missing-identity",
      "changed-identity",
      "missing-connection",
      "bad-node",
      "bad-item",
      "missing-page",
      "missing-cursor",
      "repeated-cursor",
      "invalid-next",
      "transport",
    ]) {
      scenario = invalid;
      requests.length = 0;
      await assert.rejects(tracker.loadEpic("parent"));
      await assert.rejects(tracker.listDeps("parent"));
      observe(`${invalid} rejects the whole graph instead of returning its first page`, true, {
        requests: requests.length,
      });
    }
    scenario = "cap";
    await assert.rejects(tracker.loadEpic("parent"), /pagination exceeded/);
    await assert.rejects(tracker.listDeps("parent"), /pagination exceeded/);
    observe("nonterminating unique cursors fail explicitly at the traversal bound", true, {});
    scenario = "complete";
    assert.deepEqual(await tracker.listDeps("parent"), deps);
    assert.deepEqual(await tracker.loadEpic("parent"), epic);
    observe("a repaired scan starts afresh and produces the exact complete graph", true, {});
  } finally {
    await server.stop(true);
  }
}

function connection(nodes: unknown[], cursor: string | null, more = cursor !== null) {
  return { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } };
}

function child(index: number) {
  return {
    id: `child-${index}`,
    identifier: `ENG-${index + 2}`,
    title: `Child ${index}`,
    subIssueSortOrder: 20 - index,
  };
}

function edge(index: number) {
  return { type: "blocks", issue: { id: "parent" }, relatedIssue: { id: `child-${index}` } };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations: unknown[] = [];
  try {
    await probeLinearDependencyPagination((name, passed, observed) => {
      observations.push({ name, passed, observed });
    });
  } finally {
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  }
}
