import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { handleStatusRequest, type FindingsResponse, type FindingGroupsResponse } from "../src/web";
import { statusFixture } from "../src/web/test/fixtures";

const output = process.argv[2] ?? "/tmp/pas892-evidence";
await mkdir(output, { recursive: true });
const snapshot = statusFixture();
snapshot.source = "live";
const findings: FindingsResponse = {
  findings: [
    {
      id: 1,
      repository: "pmdroid/paws-app",
      path: "src/auth/token.ts",
      lines: "12-14",
      severity: "P1",
      review: "security-review",
      text: "Use a constant-time comparison when checking the signing secret.",
      bugClass: "timing",
      why: "pre-existing",
      firstSeenAt: "2026-10-27T06:00:00Z",
      lastSeenAt: "2026-10-28T06:00:00Z",
      itemCount: 3,
      items: [{ id: "PAS-891", title: "Store review findings" }],
      status: "open",
      statusBy: null,
      statusAt: null,
      statusReason: null,
      filedIssue: null,
    },
    {
      id: 2,
      repository: "pmdroid/paws-app",
      path: "src/linear/webhook.ts",
      lines: "23",
      severity: "P2",
      review: "security-review",
      text: "The webhook signature comparison can reveal how much of the value matched.",
      bugClass: "timing",
      why: "pre-existing",
      firstSeenAt: "2026-10-27T06:00:00Z",
      lastSeenAt: "2026-10-28T06:00:00Z",
      itemCount: 2,
      items: [{ id: "PAS-891", title: "Store review findings" }],
      status: "open",
      statusBy: null,
      statusAt: null,
      statusReason: null,
      filedIssue: null,
    },
  ],
  total: 2,
  counts: { P0: 0, P1: 1, P2: 1, P3: 0 },
  repositories: ["pmdroid/paws-app"],
  reviews: ["security-review"],
};
const groups: FindingGroupsResponse = {
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
      id: "test-group",
      workspaceId: "ws",
      repository: "pmdroid/paws-app",
      teamId: "team",
      title: "Use constant-time comparisons for secrets",
      summary:
        "Replace the secret and webhook signature comparisons with a constant-time comparison, preserving the checks for missing values and different lengths.",
      scope: "src/auth/token.ts and src/linear/webhook.ts",
      suggestedIssue: "PAS-892",
      memberIds: [1, 2],
      createdAt: 1,
      runId: "run",
      status: "open",
      statusReason: null,
      filedIssue: null,
      action: null,
      findings: findings.findings,
    },
  ],
};
const actions: unknown[] = [];
let failGroups = false;
let groupsReads = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/findings") return Response.json(findings);
    if (path === "/api/finding-groups") {
      if (request.method === "GET") {
        groupsReads++;
        if (failGroups)
          return Response.json({ error: "Grouping temporarily unavailable" }, { status: 500 });
      }
      if (request.method === "POST") {
        if (request.headers.get("x-paws-csrf") !== "fixture-csrf")
          return Response.json({ error: "CSRF token required" }, { status: 403 });
        actions.push(await request.json());
        return Response.json({ ok: true });
      }
      return Response.json(groups);
    }
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "fixture-csrf",
      })) ?? new Response(null, { status: 404 })
    );
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
      await page.goto(`http://127.0.0.1:${server.port}/status/findings`);
      await page.getByRole("button", { name: "Groups", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Use constant-time comparisons for secrets" }),
      ).toBeVisible();
      await page.getByText("Show findings", { exact: true }).click();
      await expect(page.getByRole("link", { name: "src/auth/token.ts:12-14" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: join(output, `groups-${theme}-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "src/auth/token.ts:12-14" }).click();
      await expect(page.locator("#finding-1")).toBeVisible();
      await page.screenshot({
        path: join(output, `findings-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  await page.getByRole("button", { name: "Groups", exact: true }).click();
  await page.getByRole("button", { name: "File as one issue", exact: true }).click();
  await expect.poll(() => actions.length).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "Group updated." })).toBeVisible();
  await page.getByRole("button", { name: "Add to PAS-892", exact: true }).click();
  await expect.poll(() => actions.length).toBe(2);
  await expect(page.getByRole("status").filter({ hasText: "Group updated." })).toBeVisible();
  await page.getByText("Dismiss group", { exact: true }).first().click();
  await page.getByLabel("Why dismiss this group?").fill("Already tracked in the security work.");
  await page.getByRole("button", { name: "Dismiss group", exact: true }).click();
  await expect.poll(() => actions.length).toBe(3);
  await expect(page.getByRole("status").filter({ hasText: "Group updated." })).toBeVisible();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await expect.poll(() => actions.length).toBe(4);
  await expect(page.getByRole("status").filter({ hasText: "Grouping queued." })).toBeVisible();
  failGroups = true;
  await page.goto(`http://127.0.0.1:${server.port}/status/findings`);
  await expect(page.locator("#finding-1")).toBeVisible();
  const beforeFilters = groupsReads;
  await page.locator("[data-findings-filter=severity]").selectOption("P1");
  await expect(page.locator("[data-findings-filter=severity]")).toHaveValue("P1");
  expect(groupsReads).toBe(beforeFilters);
  await page.getByRole("button", { name: "Groups", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load groups");
  failGroups = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Use constant-time comparisons for secrets" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  groups.lastRun = {
    ...groups.lastRun!,
    tokens: 0,
    finishedAt: groups.lastRun!.startedAt,
    skipReason: "No findings changed since the last completed grouping.",
  };
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme as "light" | "dark", reducedMotion: "reduce" });
      await page.goto(`http://127.0.0.1:${server.port}/status/findings`);
      await page.getByRole("button", { name: "Groups", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Skipped: No findings changed" }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: join(output, `groups-skipped-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  expect(errors).toEqual([]);
  await Bun.write(
    join(output, "observations.json"),
    JSON.stringify(
      {
        themes: ["light", "dark"],
        widths: [1440, 390],
        noHorizontalOverflow: true,
        linkedFinding: true,
        groupsFailureIsolated: true,
        filtersDoNotFetchGroups: true,
        groupsRetryRecovers: true,
        skippedRunVisible: true,
        actions,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(`Finding Groups UI evidence: ${output}`);
} finally {
  await browser.close();
  await server.stop(true);
}
