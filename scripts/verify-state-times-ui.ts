import { fixtureProvider, fullStatusFixture } from "../src/web/test/fixtures";
// The issue page's time bar, the overview's ages and its Last 24 hours, against the real status
// handler, in light and dark mode.
// Usage: bun run build:status && bun --no-env-file scripts/verify-state-times-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";
import type { StatusStateTimes } from "../src/web/src/contract";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const MIN = 60_000;
const full = fullStatusFixture();
full.source = "live";
const now = Date.parse(full.generatedAt);
function times(states: [string, number][], current: string): StatusStateTimes {
  const total = states.reduce((sum, [, minutes]) => sum + minutes, 0);
  return {
    since: new Date(now - total * MIN).toISOString(),
    until: new Date(now).toISOString(),
    current,
    states: states.map(([state, minutes]) => ({ state, ms: minutes * MIN })),
  };
}
for (const item of full.items) {
  if (item.state === "merged" || item.state === "completed") continue;
  item.stateTimes =
    item.id === "ENG-101"
      ? times(
          [
            ["queued", 89],
            ["running", 182],
            ["verifying", 11],
            ["recovering", 187],
            ["awaiting_input", 48],
            ["failed", 31],
            ["merge_queue", 73],
          ],
          "merge_queue",
        )
      : item.state === "running"
        ? times(
            [
              ["queued", 20],
              ["running", 50],
              ["recovering", 120],
            ],
            "running",
          )
        : times(
            [
              ["queued", 111],
              ["running", 40],
              ["awaiting_input", 45],
            ],
            "awaiting_input",
          );
}
full.mergedTimes = {
  since: new Date(now - 24 * 60 * MIN).toISOString(),
  merged: 19,
  medianMs: 602 * MIN,
  p90Ms: 840 * MIN,
  states: [
    { state: "recovering", ms: 187 * MIN },
    { state: "running", ms: 182 * MIN },
    { state: "queued", ms: 89 * MIN },
    { state: "merge_queue", ms: 73 * MIN },
    { state: "awaiting_input", ms: 48 * MIN },
    { state: "failed", ms: 31 * MIN },
    { state: "verifying", ms: 11 * MIN },
  ],
};
const provider = fixtureProvider(full);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    return (
      (await handleStatusRequest(request, { provider, csrfToken: "ui-fixture" })) ??
      new Response(null, { status: 404 })
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
try {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        deviceScaleFactor: 2,
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });

      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-101`);
      const bar = page.locator("section.state-times");
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("10 h 21 min since delegation");
      await expect(bar.locator(".time-seg")).toHaveCount(7);
      await expect(bar.locator('.time-seg[data-state="recovering"]')).toHaveText("187 min");
      await assertNoOverflow(page, `issue page ${scheme} ${width}`);
      await bar.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(directory, `state-times-issue-${scheme}-${width}.png`) });
      await bar.screenshot({ path: join(directory, `state-times-bar-${scheme}-${width}.png`) });

      await page.goto(`http://127.0.0.1:${server.port}/status`);
      await expect(page.getByText("3 h 10 min · 2 h recovering").first()).toBeVisible();
      const recent = page.locator("section.merged-times");
      await expect(recent).toContainText("19 merged · median 10 h 2 min · p90 14 h");
      await assertNoOverflow(page, `overview ${scheme} ${width}`);
      await page.screenshot({
        path: join(directory, `state-times-overview-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.close();
    }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
  server.stop(true);
}

async function assertNoOverflow(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) throw new Error(`${label} overflows by ${overflow} px`);
}
