import { expect, test } from "bun:test";
import { createFindingIssueAdapter } from "../src/linear";

function fakeLinear() {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const issues = new Map<string, string>();
  const comments = new Set<string>();
  let stateType = "started";
  let teamId = "team";
  const adapter = createFindingIssueAdapter({
    async query(query, variables = {}) {
      calls.push({ query, variables });
      if (query.includes("FindingOpenIssues"))
        return {
          issues: {
            nodes: [{ identifier: "PAS-20", title: "Fix secrets" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      if (query.includes("FindingFiled"))
        return {
          issues: {
            nodes: issues.has(String(variables.id))
              ? [{ id: variables.id, identifier: issues.get(String(variables.id)) }]
              : [],
          },
        };
      if (query.includes("FindingTriage"))
        return {
          team: {
            states: { nodes: [{ id: "triage", type: "triage" }] },
            labels: { nodes: [{ id: "label", name: "review finding" }] },
          },
        };
      const input = variables.input as Record<string, unknown>;
      if (query.includes("FindingGroupIssue")) {
        issues.set(String(input.id), "PAS-21");
        return { issueCreate: { success: true, issue: { id: input.id, identifier: "PAS-21" } } };
      }
      if (query.includes("FindingGroupTarget"))
        return {
          issue: {
            id: "target",
            identifier: "PAS-20",
            team: { id: teamId },
            state: { type: stateType },
            comments: {
              nodes: comments.has(String(variables.comment)) ? [{ id: variables.comment }] : [],
            },
          },
        };
      if (query.includes("FindingGroupComment")) {
        comments.add(String(input.id));
        return { commentCreate: { success: true } };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  });
  return {
    adapter,
    calls,
    setTarget: (state: string, team = "team") => {
      stateType = state;
      teamId = team;
    },
  };
}

test("group issue is a single undelegated Triage issue with review finding label and stable retries", async () => {
  const f = fakeLinear();
  const input = {
    key: "group",
    teamId: "team",
    title: "Use constant-time comparisons",
    description: "Shared fix\n\nsrc/auth.ts:12 (P1): Unsafe compare",
  };
  expect(await f.adapter.file(input)).toBe("PAS-21");
  expect(await f.adapter.file(input)).toBe("PAS-21");
  const writes = f.calls.filter((c) => c.query.includes("FindingGroupIssue"));
  expect(writes).toHaveLength(1);
  expect(writes[0]!.variables.input).toMatchObject({
    teamId: "team",
    title: input.title,
    description: input.description,
    stateId: "triage",
    labelIds: ["label"],
    delegateId: null,
  });
  expect(writes[0]!.variables.input).not.toHaveProperty("parentId");
});

test("existing-issue comments retry with one stable id and reject closed or other-team issues", async () => {
  const f = fakeLinear();
  const input = {
    key: "group",
    teamId: "team",
    identifier: "PAS-20",
    body: "Shared fix\n\nsrc/auth.ts:12 (P1): Unsafe compare",
  };
  await f.adapter.add(input);
  await f.adapter.add(input);
  expect(f.calls.filter((c) => c.query.includes("FindingGroupComment"))).toHaveLength(1);
  expect(
    f.calls.find((c) => c.query.includes("FindingGroupComment"))!.variables.input,
  ).toMatchObject({ issueId: "target", body: input.body });
  f.setTarget("completed");
  await expect(f.adapter.add({ ...input, key: "other-group" })).rejects.toThrow("no longer open");
  f.setTarget("started", "other");
  await expect(f.adapter.add({ ...input, key: "other-group" })).rejects.toThrow("outside");
});

test("only open titles for requested teams are read", async () => {
  const f = fakeLinear();
  expect(await f.adapter.openTitles(["team"], new AbortController().signal)).toEqual([
    { teamId: "team", identifier: "PAS-20", title: "Fix secrets" },
  ]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.variables).toEqual({ team: "team", after: null });
  expect(f.calls[0]!.query).toContain('nin:["completed","canceled"]');
  expect(f.calls[0]!.query).not.toContain("description");
});
