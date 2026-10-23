import { expect, test } from "bun:test";
import { createLinearMergeReads } from "../src/linear";

test("one issue read returns the merge labels and the project overview", async () => {
  const queries: string[] = [];
  const reads = createLinearMergeReads({
    async query(query) {
      queries.push(query);
      return {
        issue: {
          project: { id: "project", name: "Exports", content: "Rows leave as files." },
          labels: { nodes: [{ name: "frontend" }] },
        },
      };
    },
  });
  expect(await reads.issueMergeContext("issue")).toEqual({
    projectId: "project",
    labels: ["frontend"],
    overview: { name: "Exports", content: "Rows leave as files." },
  });
  expect(queries).toHaveLength(1);
});

test("an issue without a project has no overview", async () => {
  const reads = createLinearMergeReads({
    async query() {
      return { issue: { project: null, labels: { nodes: [] } } };
    },
  });
  expect(await reads.issueMergeContext("issue")).toEqual({
    projectId: null,
    labels: [],
    overview: null,
  });
});
