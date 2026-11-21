import { expect, test } from "bun:test";
import {
  createLinearMergeReads,
  createLinearProjectScopeReads,
  projectOverviewText,
} from "../src/linear";

test("one issue read returns the merge labels and the project overview", async () => {
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
            teams: { nodes: [{ id: "team-a" }, { id: "team-b" }] },
          },
          labels: { nodes: [{ name: "frontend" }] },
        },
      };
    },
  });
  expect(await reads.issueMergeContext("issue")).toEqual({
    projectId: "project",
    labels: ["frontend"],
    overview: { name: "Exports", content: "Rows leave as files." },
    project: { id: "project", teamIds: ["team-a", "team-b"] },
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("teams(first: 50) { nodes { id } }");
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
    project: null,
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
  expect(text).toEndWith("characters. The rest is in Linear.]");
  expect(text.length).toBeLessThanOrEqual(12_000);
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

test("a long description stays within the overview cap and names the documents left in Linear", () => {
  const text = projectOverviewText({
    name: "Exports",
    content: "d".repeat(30_000),
    documents: [
      { title: "Spec", content: "CSV first." },
      { title: "Plan", content: "Ship it." },
    ],
  });
  expect(text.length).toBeLessThanOrEqual(12_000);
  expect(text).toContain("The rest is in Linear.]");
  expect(text).toEndWith("[2 more project documents are in Linear.]");
});

test("the project overview read returns the project's id and teams even without text", async () => {
  const projects: unknown[] = [
    { id: "project", name: "Exports", content: "", teams: { nodes: [{ id: "team-a" }] } },
    null,
  ];
  const reads = createLinearProjectScopeReads({
    async query() {
      return { issue: { project: projects.shift() } };
    },
  });
  expect(await reads.projectOverview("issue")).toEqual({
    overview: null,
    project: { id: "project", teamIds: ["team-a"] },
  });
  expect(await reads.projectOverview("issue")).toEqual({ overview: null, project: null });
});
