import { statusFixture } from "../../../../test/fixtures/status";
import { expect, test } from "bun:test";
import { issueRowMatches, NO_PROJECT_FILTER, render } from "./render";

const snapshot = statusFixture();
const model = {
  phase: "ready" as const,
  snapshot,
  error: null,
  engineUrl: null,
};

function rows(html: string): { id: string; state: string; project: string }[] {
  return [
    ...html.matchAll(
      /data-issue-state="([^"]+)" data-issue-id="([^"]+)" data-issue-project="([^"]+)"/g,
    ),
  ].map(([, state, id, project]) => ({ id: id!, state: state!, project: project! }));
}

test("the issue page shows the issue's Linear project, or none", () => {
  const withProject = render({ ...model, route: { view: "issues", id: "ENG-104" } }).content;
  expect(withProject).toContain("Audit log export");
  const without = render({ ...model, route: { view: "issues", id: "ENG-102" } }).content;
  expect(without).toContain("No project");
  expect(without).not.toContain("Audit log export");
});

test("the Issues project filter lists the listed issues' projects and shows only matches", () => {
  const html = render({ ...model, route: { view: "issues", id: null } }).content;
  expect(html).toContain("data-issue-project-filter");
  expect(html).toContain('<option value="linear-audit">Audit log export</option>');
  expect(html).toContain(`<option value="${NO_PROJECT_FILTER}">No project</option>`);
  const listed = rows(html);
  expect(listed.length).toBe(snapshot.items.length);
  const shown = listed.filter((row) =>
    issueRowMatches(row, { state: "all", project: "linear-audit" }),
  );
  const expected = snapshot.items
    .filter((item) => item.project?.id === "linear-audit")
    .map((item) => item.id);
  expect(shown.map((row) => row.id)).toEqual(expected);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(listed.length);
  const none = listed.filter((row) =>
    issueRowMatches(row, { state: "all", project: NO_PROJECT_FILTER }),
  );
  expect(none.map((row) => row.id)).toEqual(
    snapshot.items.filter((item) => !item.project).map((item) => item.id),
  );
  expect(listed.filter((row) => issueRowMatches(row, { state: "all", project: "" }))).toEqual(
    listed,
  );
});

test("the project filter is left out when no listed issue has a Linear project", () => {
  const plain = { ...snapshot, items: snapshot.items.map((item) => ({ ...item, project: null })) };
  const html = render({ ...model, snapshot: plain, route: { view: "issues", id: null } }).content;
  expect(html).not.toContain("data-issue-project-filter");
});
