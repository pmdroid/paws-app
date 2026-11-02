import { expect, test } from "bun:test";
import { createIssueClosureReads } from "./issue-closures";

test("closure reads ask in chunks of 100 and keep closed or archived issues only", async () => {
  const asked: string[][] = [];
  const read = createIssueClosureReads({
    async query(query, variables) {
      expect(query).toContain("includeArchived: true");
      const ids = variables?.["ids"] as string[];
      asked.push(ids);
      return {
        issues: {
          nodes: ids
            .filter((id) => ["done", "archived", "open", "dupe"].includes(id))
            .map((id) => ({
              id,
              identifier: id.toUpperCase(),
              completedAt: id === "done" ? "2026-10-23T22:21:00Z" : null,
              canceledAt: id === "dupe" ? "2026-10-29T06:19:00Z" : null,
              archivedAt: id === "archived" ? "2026-10-25T00:00:00Z" : null,
              state: {
                type: id === "done" ? "completed" : id === "dupe" ? "duplicate" : "started",
              },
            })),
        },
      };
    },
  });
  const ids = [
    "done",
    "archived",
    "open",
    "dupe",
    ...Array.from({ length: 98 }, (_, i) => `x${i}`),
  ];
  expect(await read(ids)).toEqual([
    {
      issueId: "done",
      organizationId: null,
      identifier: "DONE",
      stateType: "completed",
      closedAtMs: Date.parse("2026-10-23T22:21:00Z"),
    },
    {
      issueId: "archived",
      organizationId: null,
      identifier: "ARCHIVED",
      stateType: "canceled",
      closedAtMs: Date.parse("2026-10-25T00:00:00Z"),
    },
    {
      issueId: "dupe",
      organizationId: null,
      identifier: "DUPE",
      stateType: "canceled",
      closedAtMs: Date.parse("2026-10-29T06:19:00Z"),
    },
  ]);
  expect(asked.map((chunk) => chunk.length)).toEqual([100, 2]);
});
