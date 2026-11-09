import { expect, test } from "bun:test";
import { createLinearSubIssueMethods } from "./sub-issues";

function client(created: Record<string, unknown>[]) {
  return {
    async query(query: string, variables?: Record<string, unknown>) {
      if (query.includes("SubIssueDelegate")) return { viewer: { id: "paws-app-user" } };
      if (query.includes("SubIssueParent"))
        return { issue: { id: "acme-parent", team: { id: "acme-team" }, project: { id: "p" } } };
      if (query.includes("SubIssuesFiled")) return { issues: { nodes: [] } };
      const input = variables?.["input"] as Record<string, unknown>;
      created.push(input);
      return {
        issueCreate: {
          success: true,
          issue: { id: input["id"], identifier: "ACME-2", url: null },
        },
      };
    },
  };
}

const request = {
  key: "remaining:acme",
  parentIssueId: "acme-parent",
  drafts: [{ title: "Part 2", description: "Scope", acceptanceCriteria: ["Done"], blockedBy: [] }],
};

test("a delegated sub-issue is created with the app user as its delegate", async () => {
  const created: Record<string, unknown>[] = [];
  await createLinearSubIssueMethods(client(created)).createSubIssues({
    ...request,
    delegate: true,
  });
  expect(created[0]).toMatchObject({ delegateId: "paws-app-user", projectId: "p" });
});

test("a sub-issue without delegate has no delegate", async () => {
  const created: Record<string, unknown>[] = [];
  await createLinearSubIssueMethods(client(created)).createSubIssues(request);
  expect(created[0]).not.toHaveProperty("delegateId");
});
