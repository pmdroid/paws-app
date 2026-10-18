import { expect, test } from "bun:test";
import {
  createLinearClient,
  createLinearProjectScopeReads,
  type DependencyEdge,
} from "../src/linear";
import { previewProject, type ProjectSelection } from "../src/project-execution";

test("project loads from its Linear URL, slug or UUID", async () => {
  const uuid = "6a0e5c9e-1b2f-4c3d-9e8f-0123456789ab";
  const lookups: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        query: string;
        variables: { id?: string; hash?: string; slug?: string };
      };
      if (body.query.includes("PawsProjectSlug")) {
        lookups.push([body.variables.hash, body.variables.slug]);
        const nodes = {
          f17b6d311237: [
            { id: uuid, url: "https://linear.app/kyku/project/closeout-f17b6d311237" },
          ],
          "000000000000": [{ id: uuid, url: "https://linear.app/kyku/project/other-111111111111" }],
          "222222222222": [
            { id: uuid, url: "https://linear.app/kyku/project/other-33222222222222" },
          ],
        }[body.variables.hash ?? ""];
        return Response.json({ data: { projects: { nodes: nodes ?? [] } } });
      }
      if (body.variables.id !== uuid) return Response.json({ errors: [{ message: "Not found" }] });
      return Response.json({
        data: {
          viewer: { app: true, organization: { id: "organization" } },
          project: {
            id: uuid,
            name: "Closeout output and evidence",
            lead: null,
            updatedAt: "2026-10-14T00:00:00Z",
            issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      });
    },
  });
  const reads = createLinearProjectScopeReads(
    createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: async () => "fixture",
        forceRefresh: async () => "fixture",
      },
      fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}`, init),
    }),
  );
  try {
    for (const reference of [
      "https://linear.app/kyku/project/closeout-output-and-evidence-f17b6d311237/overview",
      "https://linear.app/kyku/project/closeout-output-and-evidence-f17b6d311237",
      "closeout-output-and-evidence-f17b6d311237",
      "F17B6D311237",
      ` ${uuid} `,
      `https://linear.app/kyku/project/${uuid}/overview`,
    ])
      expect((await reads.loadProject(reference)).id).toBe(uuid);
    const slug = "closeout-output-and-evidence-f17b6d311237";
    expect(lookups).toEqual([
      ["f17b6d311237", slug],
      ["f17b6d311237", slug],
      ["f17b6d311237", slug],
      ["f17b6d311237", "f17b6d311237"],
    ]);
    for (const reference of ["missing-000000000000", "missing-222222222222"])
      await expect(reads.loadProject(reference)).rejects.toThrow("No Linear project");
    for (const reference of [
      "https://linear.app/kyku/issue/PAS-82",
      "https://linear.app/project/issue/PAS-82",
      "https://",
      "https://linear.app/kyku/project/bad%E0-f17b6d311237",
    ])
      await expect(reads.loadProject(reference)).rejects.toThrow(
        "Paste a Linear project URL or ID.",
      );
  } finally {
    await server.stop(true);
  }
});

test("project selection reads complete HTTP pages and rejects incomplete scope", async () => {
  let fault = "";
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      const body = (await request.json()) as { variables: { after: string | null } };
      const page = Number(body.variables.after ?? 0);
      const issue = {
        id: fault === "duplicate" ? "issue-0" : `issue-${page}`,
        identifier: `PAW-${page}`,
        title: `Issue ${page}`,
        description: "Implement the requested behavior.",
        updatedAt: "2026-10-14T00:00:00Z",
        team: { id: "team" },
        project: { id: fault === "membership" ? "other" : "project" },
        assignee: null,
        parent: null,
        priority: 1,
        state: { type: "unstarted" },
      };
      return Response.json({
        data: {
          viewer: { app: true, organization: { id: "organization" } },
          project: {
            id: "project",
            name: "Project",
            lead: null,
            updatedAt:
              fault === "change" && page > 0 ? "2026-10-14T01:00:00Z" : "2026-10-14T00:00:00Z",
            issues: {
              nodes: fault === "malformed" ? [null] : [issue],
              pageInfo: {
                hasNextPage: page < 11,
                endCursor: fault === "cycle" ? "1" : `${page + 1}`,
              },
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
    fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}`, init),
  });
  const reads = createLinearProjectScopeReads(client);
  try {
    const project = await reads.loadProject("project");
    expect(project.issues).toHaveLength(12);
    expect(requests).toBe(12);
    for (fault of ["duplicate", "membership", "change", "malformed", "cycle"])
      await expect(reads.loadProject("project")).rejects.toThrow();
    const before = requests;
    await expect(reads.loadProject("project", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(requests).toBe(before);
    fault = "";
    const selection: ProjectSelection = {
      projectId: "project",
      issueIds: ["issue-1", "issue-0"],
      repository: "owner/repo",
      targetBranch: "main",
      leadUserId: "member",
      steeringRoles: ["owner", "member"],
    };
    let edges: DependencyEdge[] = [
      { blockerLinearIssueId: "issue-0", blockedLinearIssueId: "issue-1" },
      { blockerLinearIssueId: "external", blockedLinearIssueId: "issue-0" },
    ];
    const tracker = { ...reads, listDeps: async () => edges };
    const preview = await previewProject(tracker, selection, { organizationId: "organization" });
    expect(preview.order).toEqual(["issue-0", "issue-1"]);
    expect(preview.excludedIssueIds).toHaveLength(10);
    expect(preview.externalBlockerIds).toEqual(["external"]);
    expect(preview.problems).toEqual([]);
    expect(
      (
        await previewProject(
          tracker,
          { ...selection, issueIds: [...selection.issueIds].reverse() },
          { organizationId: "organization" },
        )
      ).generation,
    ).toBe(preview.generation);
    edges = [...edges, { blockerLinearIssueId: "issue-1", blockedLinearIssueId: "issue-0" }];
    const cyclic = await previewProject(tracker, selection, { organizationId: "organization" });
    expect(cyclic.generation).not.toBe(preview.generation);
    expect(cyclic.order).toEqual([]);
    expect(cyclic.problems[0]).toContain("cycle");
    await expect(
      previewProject(tracker, selection, { organizationId: "outsider" }),
    ).rejects.toThrow("workspace");
    await expect(
      previewProject(
        tracker,
        { ...selection, issueIds: ["missing"] },
        { organizationId: "organization" },
      ),
    ).rejects.toThrow("left the project");
  } finally {
    await server.stop(true);
  }
});
