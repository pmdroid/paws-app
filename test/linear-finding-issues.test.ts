import { expect, test } from "bun:test";
import { createLinearTracker, findingIssueId, findingIssueState } from "../src/linear";

const request = {
  key: "a".repeat(64),
  relatedIssueId: "PAS-633",
  title: "unchecked null: the legacy reader skips the guard",
  description: "body",
};

/** A Linear server for the finding issue queries; `labels` are the labels it already has. */
function linearServer(
  options: { labels?: unknown[]; triage?: boolean; failCreate?: boolean } = {},
) {
  const issues = new Map<string, { input: Record<string, unknown>; identifier: string }>();
  const relations: Record<string, unknown>[] = [];
  const labelsCreated: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const client = {
    async query(query: string, variables: Record<string, unknown> = {}) {
      queries.push(query.slice(0, query.indexOf("(")));
      if (query.includes("FindingIssueTarget")) {
        const ids = variables.ids as string[];
        return {
          issue: {
            id: "related-uuid",
            team: {
              id: "team-pas",
              states: {
                nodes: [
                  { id: "state-backlog-2", type: "backlog", position: 5 },
                  { id: "state-backlog", type: "backlog", position: 1 },
                  ...(options.triage === false
                    ? []
                    : [{ id: "state-triage", type: "triage", position: 0 }]),
                ],
              },
            },
            project: { id: "project-fixes" },
          },
          issues: {
            nodes: ids
              .filter((id) => issues.has(id))
              .map((id) => ({
                id,
                identifier: issues.get(id)!.identifier,
                url: null,
                relations: {
                  nodes: relations
                    .filter((relation) => relation.issueId === id)
                    .map((relation) => ({
                      type: relation.type,
                      relatedIssue: { id: relation.relatedIssueId },
                    })),
                },
              })),
          },
        };
      }
      if (query.includes("FindingIssueLabels"))
        return { issueLabels: { nodes: options.labels ?? [] } };
      if (query.includes("FindingIssueLabelCreate")) {
        labelsCreated.push(variables.input as Record<string, unknown>);
        return { issueLabelCreate: { success: true, issueLabel: { id: "label-new" } } };
      }
      if (query.includes("FindingIssueCreate")) {
        if (options.failCreate) throw new Error("Linear is unavailable");
        const input = variables.input as Record<string, unknown>;
        const identifier = `PAS-${900 + issues.size}`;
        issues.set(input.id as string, { input, identifier });
        return {
          issueCreate: {
            success: true,
            issue: { id: input.id, identifier, url: `https://linear.app/kyku/issue/${identifier}` },
          },
        };
      }
      if (query.includes("FindingIssueRelated")) {
        relations.push(variables.input as Record<string, unknown>);
        return { issueRelationCreate: { success: true } };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    },
  };
  return { client, issues, relations, labelsCreated, queries };
}

test("files in the related issue's team and project, in Triage, labelled, related and not delegated", async () => {
  const server = linearServer({ labels: [{ id: "label-other-team", team: { id: "team-x" } }] });
  const filed = await createLinearTracker(server.client).fileFindingIssue(request);
  expect(filed).toEqual({
    id: findingIssueId(request.key),
    identifier: "PAS-900",
    url: "https://linear.app/kyku/issue/PAS-900",
  });
  expect(server.labelsCreated).toEqual([{ name: "review finding", teamId: "team-pas" }]);
  expect(server.issues.get(filed.id)!.input).toEqual({
    id: filed.id,
    teamId: "team-pas",
    projectId: "project-fixes",
    stateId: "state-triage",
    labelIds: ["label-new"],
    title: request.title,
    description: "body",
  });
  expect(server.relations).toEqual([
    {
      id: expect.any(String),
      type: "related",
      issueId: filed.id,
      relatedIssueId: "related-uuid",
    },
  ]);
});

test("reuses the team's or the workspace's label, and files into Backlog without Triage", async () => {
  const server = linearServer({
    triage: false,
    labels: [
      { id: "label-group", isGroup: true, team: null },
      { id: "label-workspace", team: null },
    ],
  });
  const filed = await createLinearTracker(server.client).fileFindingIssue(request);
  expect(server.labelsCreated).toEqual([]);
  expect(server.issues.get(filed.id)!.input).toMatchObject({
    stateId: "state-backlog",
    labelIds: ["label-workspace"],
  });
});

test("a retry finds the issue an earlier call filed and creates nothing twice", async () => {
  const server = linearServer({ labels: [{ id: "label-team", team: { id: "team-pas" } }] });
  const tracker = createLinearTracker(server.client);
  await tracker.fileFindingIssue(request);
  const again = await tracker.fileFindingIssue(request);
  expect(again.identifier).toBe("PAS-900");
  expect(server.issues.size).toBe(1);
  expect(server.relations).toHaveLength(1);
});

test("a Linear failure rejects with its message", async () => {
  const server = linearServer({ failCreate: true });
  await expect(createLinearTracker(server.client).fileFindingIssue(request)).rejects.toThrow(
    "Linear is unavailable",
  );
});

test("findingIssueState prefers Triage, then the first Backlog state", () => {
  expect(
    findingIssueState([
      { id: "b", type: "backlog", position: 2 },
      { id: "t", type: "triage", position: 3 },
    ]),
  ).toBe("t");
  expect(
    findingIssueState([
      { id: "b2", type: "backlog", position: 2 },
      { id: "b1", type: "backlog", position: 1 },
    ]),
  ).toBe("b1");
  expect(findingIssueState([{ id: "u", type: "unstarted", position: 0 }])).toBeNull();
});
