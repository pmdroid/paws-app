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

test("a split files under the parent's milestone and delegates only after every relation exists", async () => {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const linear = {
    async query(query: string, variables?: Record<string, unknown>) {
      const input = variables?.["input"] as Record<string, unknown> | undefined;
      if (query.includes("SubIssueDelegate ")) return { viewer: { id: "paws-app-user" } };
      if (query.includes("SubIssueParent"))
        return {
          issue: {
            ...{ id: "acme-parent", team: { id: "acme-team" }, project: { id: "p" } },
            projectMilestone: { id: "m" },
          },
        };
      if (query.includes("SubIssuesFiled")) return { issues: { nodes: [] } };
      if (query.includes("issueRelationCreate")) {
        calls.push(`relate ${String(input?.["issueId"])} ${String(input?.["relatedIssueId"])}`);
        return { issueRelationCreate: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push(`delegate ${String(variables?.["id"])}`);
        return { issueUpdate: { success: true } };
      }
      created.push(input!);
      calls.push(`create ${String(input?.["id"])}`);
      return {
        issueCreate: {
          success: true,
          issue: { id: input!["id"], identifier: "ACME-2", url: null },
        },
      };
    },
  };
  const filed = await createLinearSubIssueMethods(linear).createSubIssues({
    key: "split:acme",
    parentIssueId: "acme-parent",
    drafts: [
      { title: "One", description: "d", acceptanceCriteria: ["Done"], blockedBy: [] },
      { title: "Two", description: "d", acceptanceCriteria: ["Done"], blockedBy: [0] },
    ],
    delegate: true,
    blocksParent: true,
  });
  const [one, two] = filed.map((issue) => issue.id);
  expect(created.map((input) => [input["projectMilestoneId"], input["delegateId"]])).toEqual([
    ["m", undefined],
    ["m", undefined],
  ]);
  expect(calls).toEqual([
    `create ${one}`,
    `create ${two}`,
    `relate ${one} ${two}`,
    `relate ${one} acme-parent`,
    `relate ${two} acme-parent`,
    `delegate ${one}`,
    `delegate ${two}`,
  ]);
});
