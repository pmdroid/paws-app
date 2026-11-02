import {
  fixtureProvider,
  fullStatusFixture,
  withRuleResults,
} from "../src/dashboard/test/fixtures";
// The issue page of a task fixing a merge conflict after Closeout accepted it, against the real
// status handler: the stepper names the phase and the details stay folded until opened.
// Usage: bun run build:dashboard && bun --no-env-file scripts/verify-issue-journey-ui.ts <screenshot dir> [--before]
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
const before = process.argv.includes("--before");
mkdirSync(directory, { recursive: true });

const full = withRuleResults(fullStatusFixture());
full.source = "live";
const item = full.items.find((entry) => entry.id === "ENG-101")!;
const run = full.runs.find((entry) => entry.itemId === "ENG-101")!;
const at = (minutes: number) =>
  new Date(Date.parse(full.generatedAt) - minutes * 60_000).toISOString();
item.state = "running";
run.state = "running";
item.timeline = [
  ...(item.timeline ?? []),
  {
    at: at(9),
    kind: "restart",
    from: "merge_queue",
    to: "queued",
    event: "restart",
    reason: "conflict",
    actor: null,
  },
  {
    at: at(8),
    kind: "transition",
    from: "queued",
    to: "running",
    event: "dispatched",
    reason: null,
    actor: null,
  },
];
item.doing = { kind: "running", runners: ["agentbox"], since: at(8), stalled: false };
item.activeMs = 74 * 60_000;

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
const prefix = before ? "before" : "after";
try {
  for (const [width, scheme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-101`);
    await expect(page.getByRole("heading", { level: 1, name: /Export job worker/ })).toBeVisible();
    if (!before) {
      const stepper = page.getByRole("list", { name: "Issue progress" });
      await expect(stepper.locator('[aria-current="step"]')).toHaveText(/Fixing merge conflicts/);
      await expect(page.getByText(/Main moved under this pull request/)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Closeout/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(page.getByRole("button", { name: /Timeline/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.screenshot({
      path: join(directory, `${prefix}-issue-${width}-${scheme}.png`),
      fullPage: true,
    });
    if (width === 1440 && scheme === "light") {
      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-100`);
      await expect(page.getByRole("heading", { level: 1, name: /Retention policy/ })).toBeVisible();
      if (!before) {
        const stepper = page.getByRole("list", { name: "Issue progress" });
        await expect(stepper.locator('[aria-current="step"]')).toHaveClass(/needs/);
        await expect(
          page.getByRole("heading", { level: 2, name: "Closeout exhausted" }),
        ).toBeVisible();
        const rules = page.getByRole("button", { name: /^Rules/ });
        if ((await rules.getAttribute("aria-expanded")) === "false") await rules.click();
        await expect(page.getByRole("button", { name: /^Rules/ })).toHaveAttribute(
          "aria-expanded",
          "true",
        );
      }
      await page.screenshot({
        path: join(directory, `${prefix}-needs-you-${width}.png`),
        fullPage: true,
      });
    }
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Issue page checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
