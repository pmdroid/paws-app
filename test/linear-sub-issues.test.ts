import { expect, test } from "bun:test";
import type { SubIssueDraft } from "../src/core";
import { createLinearTracker, subIssueDescription, subIssueId } from "../src/linear";

const drafts: SubIssueDraft[] = [
  {
    title: "First",
    description: "Do the first part.",
    acceptanceCriteria: ["test passes"],
    blockedBy: [],
  },
  { title: "Second", description: "", acceptanceCriteria: ["lint passes"], blockedBy: [0] },
  { title: "Third", description: "Last.", acceptanceCriteria: ["screenshot"], blockedBy: [0, 1] },
];

/** A Linear server for the sub-issue mutations, failing the nth issueCreate once when asked. */
function linearServer(failCreateAt?: number) {
  const issues = new Map<
    string,
    { id: string; identifier: string; url: string; parent: string; input: Record<string, unknown> }
  >();
  const relations: { id: string; type: string; issueId: string; relatedIssueId: string }[] = [];
  const labelled: string[] = [];
  let creates = 0;
  let failed = false;
  const client = {
    async query(query: string, variables: Record<string, unknown> = {}) {
      if (query.includes("SubIssueParent"))
        return { issue: { id: "parent-uuid", team: { id: "team" }, project: { id: "project" } } };
      if (query.includes("SubIssuesFiled")) {
        const ids = variables.ids as string[];
        return {
          issues: {
            nodes: ids
              .filter((id) => issues.has(id))
              .map((id) => {
                const issue = issues.get(id)!;
                return {
                  id,
                  identifier: issue.identifier,
                  url: issue.url,
                  parent: { id: issue.parent },
                  relations: {
                    nodes: relations
                      .filter((relation) => relation.issueId === id)
                      .map((relation) => ({
                        type: relation.type,
                        relatedIssue: { id: relation.relatedIssueId },
                      })),
                  },
                };
              }),
          },
        };
      }
      if (query.includes("SubIssueCreate")) {
        creates++;
        if (creates === failCreateAt && !failed) {
          failed = true;
          throw new Error("Linear is unavailable");
        }
        const input = variables.input as Record<string, unknown>;
        const id = input.id as string;
        if (issues.has(id)) throw new Error("duplicate issue id");
        const identifier = `ENG-${10 + issues.size}`;
        issues.set(id, {
          id,
          identifier,
          url: `https://linear.app/acme/issue/${identifier}`,
          parent: input.parentId as string,
          input,
        });
        return {
          issueCreate: { success: true, issue: { id, identifier, url: issues.get(id)!.url } },
        };
      }
      if (query.includes("SubIssueBlocks")) {
        const input = variables.input as (typeof relations)[number];
        if (relations.some((relation) => relation.id === input.id))
          throw new Error("duplicate relation id");
        relations.push(input);
        return { issueRelationCreate: { success: true } };
      }
      // The repository label: none on the issue yet, an existing group and label.
      if (query.includes("RepositoryLabelAdd")) {
        labelled.push(variables.id as string);
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("RepositoryLabelIssue")) return { issue: { labels: { nodes: [] } } };
      if (query.includes("RepositoryLabelGroups") || query.includes("RepositoryLabels("))
        return { issueLabels: { nodes: [{ id: "label" }] } };
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    },
  };
  return { client, issues, relations, labelled };
}

test("createSubIssues files drafts under the parent with blocks relations and the repository label", async () => {
  const server = linearServer();
  const tracker = createLinearTracker(server.client);
  const filed = await tracker.createSubIssues({
    key: "question",
    parentIssueId: "ENG-1",
    drafts,
    repository: "acme/app",
  });
  expect(filed.map((issue) => issue.identifier)).toEqual(["ENG-10", "ENG-11", "ENG-12"]);
  expect(filed.map((issue) => issue.id)).toEqual(
    [0, 1, 2].map((index) => subIssueId("question", index)),
  );
  const first = server.issues.get(filed[0]!.id)!.input;
  expect(first).toMatchObject({
    teamId: "team",
    parentId: "parent-uuid",
    projectId: "project",
    title: "First",
    description: subIssueDescription(drafts[0]!),
  });
  expect(String(first.description)).toContain("## Acceptance criteria\n\n- [ ] test passes");
  expect(
    server.relations.map(({ issueId, relatedIssueId, type }) => [type, issueId, relatedIssueId]),
  ).toEqual([
    ["blocks", filed[0]!.id, filed[1]!.id],
    ["blocks", filed[0]!.id, filed[2]!.id],
    ["blocks", filed[1]!.id, filed[2]!.id],
  ]);
  expect(server.labelled).toEqual(filed.map((issue) => issue.id));
});

test("a retry after a failure part-way files each sub-issue and relation once", async () => {
  const server = linearServer(2);
  const tracker = createLinearTracker(server.client);
  const request = { key: "question", parentIssueId: "ENG-1", drafts };
  await expect(tracker.createSubIssues(request)).rejects.toThrow("unavailable");
  expect(server.issues.size).toBe(1);
  const filed = await tracker.createSubIssues(request);
  expect(server.issues.size).toBe(3);
  expect(server.relations).toHaveLength(3);
  const again = await tracker.createSubIssues(request);
  expect(again).toEqual(filed);
  expect(server.issues.size).toBe(3);
  expect(server.relations).toHaveLength(3);
});

test("createSubIssues refuses drafts whose blocks order points forward", async () => {
  const tracker = createLinearTracker(linearServer().client);
  await expect(
    tracker.createSubIssues({
      key: "question",
      parentIssueId: "ENG-1",
      drafts: [{ ...drafts[0]!, blockedBy: [1] }, drafts[1]!],
    }),
  ).rejects.toThrow("earlier sub-issues");
});
