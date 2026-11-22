import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";
import type { StatusCheck } from "../src/dashboard/src/contract";
import {
  fixtureProvider,
  fullStatusFixture,
  withRuleResults,
} from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const full = withRuleResults(fullStatusFixture());
full.source = "live";
full.risk = {
  tier: "normal",
  head: "91fd0c4",
  base: "a1c9e07",
  classifiedAt: full.generatedAt,
  paths: [],
  securityReview: null,
};
const failed = full.verdicts.find((entry) => entry.itemId === "ENG-100")!;
failed.reviews = [
  {
    id: "independent-review",
    rounds: [
      {
        attempt: 3,
        baseSha: "a1c9e07",
        headSha: "91fd0c4",
        failOn: "P1",
        findings: [
          {
            severity: "P1",
            location: "src/retention/job.ts:44",
            explanation: "Rows under legal hold are deleted by the nightly job.",
            evidence: "job.ts:44 deletes before it reads the hold flag.",
            preExisting: false,
            blocking: true,
            since: null,
          },
        ],
        fixed: [],
      },
    ],
  },
];
const running = structuredClone(full.verdicts.find((entry) => entry.itemId === "ENG-101")!);
running.itemId = "ENG-102";
running.runId = full.runs.find((entry) => entry.itemId === "ENG-102")?.id;
running.decision = "running";
running.attempts = undefined;
running.checks = running.checks.map((check, index): StatusCheck =>
  index === 0 ? check : { ...check, state: "running", active: true, exitCode: null },
);
full.verdicts.push(running);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(full),
        csrfToken: "ui-fixture",
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
const errors: string[] = [];
const CASES = [
  ["accepted", "ENG-101", /^Accepted at b7e21aa in round 1 of 3 · 2 checks · 1 review/, []],
  [
    "failed",
    "ENG-100",
    /^Exhausted at 91fd0c4 in round 3 of 3/,
    [
      /^Failed unit retention\.test\.ts/,
      /^Open P1 src\/retention\/job\.ts:44/,
      /^Rule broke api-contract/,
    ],
  ],
  ["running", "ENG-102", /· running /, []],
] as const;
try {
  for (const width of [1440, 390]) {
    for (const [name, id, summary, blockers] of CASES) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/dashboard/issues/${id}`);
      const section = page.locator('section.closeout-overview[aria-label="Closeout"]');
      await expect(section.locator("[data-closeout-summary]")).toHaveText(summary);
      for (const blocker of blockers)
        await expect(
          section.locator("[data-closeout-blocker]").filter({ hasText: blocker }),
        ).toBeVisible();
      for (const row of ["checks", "reviews", "rules", "risk"])
        await expect(section.locator(`[data-closeout-row="${row}"]`)).toBeVisible();
      for (const gone of ["Review findings", "Rules", "Risk"])
        await expect(page.locator(`section.issue-fold[aria-label="${gone}"]`)).toHaveCount(0);
      const details = section.getByRole("button", { name: /View verification details/ });
      await section.screenshot({ path: join(directory, `${name}-${width}.png`) });
      if ((await details.getAttribute("aria-expanded")) === "false") {
        await expect(section.locator('[data-action="toggle-check"]')).toHaveCount(0);
        await details.click();
      }
      await expect(section.getByRole("heading", { name: "Checks", level: 2 })).toBeVisible();
      await expect(section.locator("#risk-tier")).toBeVisible();
      if (name === "failed") {
        await expect(section.locator("section.review-findings")).toBeVisible();
        await expect(section.locator("section.rules-section")).toBeVisible();
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(directory, `${name}-details-${width}.png`),
        fullPage: true,
      });
      await page.close();
    }
  }
  expect(errors).toEqual([]);
  console.log(`Closeout section checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
