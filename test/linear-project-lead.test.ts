import { expect, test } from "bun:test";
import { createLinearTracker } from "../src/linear";

function tracker(project: unknown, child: unknown) {
  return createLinearTracker({
    async query() {
      return {
        issue: {
          id: "issue",
          identifier: "PAS-1",
          title: "Issue",
          description: null,
          team: { id: "team" },
          project,
          assignee: null,
          priority: 0,
          state: { type: "unstarted" },
          children: {
            nodes: [
              {
                id: "child",
                identifier: "PAS-2",
                title: "Child",
                team: { id: "team" },
                project: child,
                assignee: null,
                priority: 0,
                state: { type: "unstarted" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    },
  });
}

test("an issue snapshot reads the lead of each issue's Linear project", async () => {
  const snapshot = await tracker(
    { id: "project", lead: { id: "lead" } },
    { id: "other", lead: null },
  ).loadEpic("issue");
  expect(snapshot.projectId).toBe("project");
  expect(snapshot.projectLeadId).toBe("lead");
  expect(snapshot.subIssues[0]).toMatchObject({ projectId: "other", projectLeadId: null });
});

test("an issue outside any Linear project has no project lead", async () => {
  const snapshot = await tracker(null, null).loadEpic("issue");
  expect(snapshot).toMatchObject({ projectId: null, projectLeadId: null });
});

test("a malformed project lead is refused", async () => {
  await expect(
    tracker({ id: "project", lead: { id: "" } }, null).loadEpic("issue"),
  ).rejects.toThrow("project lead");
});
