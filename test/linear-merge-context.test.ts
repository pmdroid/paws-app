import { expect, test } from "bun:test";
import { createLinearMergeReads, projectOverviewText } from "../src/linear";

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

test("project documents follow the description in the overview text", async () => {
  const queries: string[] = [];
  const reads = createLinearMergeReads({
    async query(query) {
      queries.push(query);
      return {
        issue: {
          project: {
            id: "project",
            name: "Exports",
            content: "Rows leave as files.",
            documents: {
              nodes: [
                { title: "Spec", content: "CSV first." },
                { title: "Empty", content: "  " },
                { title: "Long", content: "x".repeat(20_001) },
              ],
            },
          },
          labels: { nodes: [] },
        },
      };
    },
  });
  const { overview } = await reads.issueMergeContext("issue");
  expect(queries[0]).toContain("documents(first: 10, orderBy: updatedAt)");
  expect(overview?.documents?.map((document) => document.title)).toEqual(["Spec", "Long"]);
  const text = projectOverviewText(overview);
  expect(text).toStartWith(
    "Project overview: Exports\n\nRows leave as files.\n\nProject document: Spec\n\nCSV first.\n\nProject document: Long\n\n",
  );
  expect(text).toEndWith("[Document cut at 20,000 characters. The rest is in Linear.]");
});

test("a project with documents and no description still has an overview", async () => {
  const reads = createLinearMergeReads({
    async query() {
      return {
        issue: {
          project: {
            id: "project",
            name: "Exports",
            content: null,
            documents: { nodes: [{ title: "Spec", content: "CSV first." }] },
          },
          labels: { nodes: [] },
        },
      };
    },
  });
  const { overview } = await reads.issueMergeContext("issue");
  expect(projectOverviewText(overview)).toBe(
    "Project: Exports\n\nProject document: Spec\n\nCSV first.",
  );
});
