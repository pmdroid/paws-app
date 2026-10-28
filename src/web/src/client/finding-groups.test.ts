import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderFindingGroups } from "./finding-groups";
import { themedMarkup } from "./theme";
import type { FindingGroupsResponse } from "../finding-groups";

const data: FindingGroupsResponse = {
  canRun: true,
  lastRun: {
    id: "run",
    startedAt: Date.parse("2026-10-28T06:00Z"),
    finishedAt: Date.parse("2026-10-28T06:00:12Z"),
    status: "completed",
    tokens: 1500,
    groupCount: 1,
    error: null,
  },
  groups: [
    {
      id: "group",
      workspaceId: "ws",
      repository: "acme/app",
      teamId: "team",
      title: "Use constant-time comparisons",
      summary: "Compare secrets without leaking timing",
      scope: "src/auth and src/linear",
      suggestedIssue: "PAS-20",
      memberIds: [1],
      createdAt: 1,
      runId: "run",
      status: "open",
      statusReason: null,
      filedIssue: null,
      action: null,
      findings: [
        {
          id: 1,
          repository: "acme/app",
          path: "src/auth.ts",
          lines: "12-14",
          severity: "P1",
          review: "security",
          text: '<img src=x onerror="alert(1)">',
          bugClass: "timing",
          why: "pre-existing",
          firstSeenAt: "2026-10-28T06:00Z",
          lastSeenAt: "2026-10-28T06:00Z",
          itemCount: 2,
          items: [],
          status: "open",
          statusBy: null,
          statusAt: null,
          statusReason: null,
          filedIssue: null,
        },
      ],
    },
  ],
};

test("Groups renders the shared fix, scope, severity, members, explicit actions and run cost", () => {
  const html = renderFindingGroups(data, true, false);
  for (const value of [
    "Use constant-time comparisons",
    "Compare secrets without leaking timing",
    "src/auth and src/linear",
    "P1: 1",
    "src/auth.ts:12-14",
    "1 finding",
    "File as one issue",
    "Add to PAS-20",
    "Dismiss group",
    "Run now",
    "1500 tokens",
    "12.0 s",
    "2026-10-28 06:00",
  ])
    expect(html).toContain(value);
  expect(html).toContain("?status=all#finding-1");
  expect(html).toContain("&lt;img");
  const themed = renderToStaticMarkup(themedMarkup(html));
  expect(themed).not.toContain("<img");
  expect(themed).toContain("&lt;img");
});

test("run now is admin-only, remote views are read-only and actions disable while busy", () => {
  expect(renderFindingGroups({ ...data, canRun: false }, true, false)).not.toContain("Run now");
  const remote = renderFindingGroups(data, false, false);
  expect(remote).not.toContain("data-group-action");
  expect(remote).not.toContain("data-group-dismiss");
  expect(renderFindingGroups(data, true, true)).toContain(
    'data-group-action="file" data-group-id="group" disabled',
  );
  expect(renderFindingGroups({ groups: [], lastRun: null, canRun: true }, true, false)).toContain(
    "No groups yet",
  );
});

test("the run status explains an unchanged snapshot without implying a helper ran", () => {
  const html = renderFindingGroups(
    {
      ...data,
      lastRun: {
        ...data.lastRun!,
        skipReason: "No findings changed since the last completed grouping.",
      },
    },
    true,
    false,
  );
  expect(html).toContain("Skipped: No findings changed");
});
