import { statusFixture } from "../src/web/test/fixtures";
// The run page of a task second in its repository's merge queue, against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-merge-queue-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const snapshot = statusFixture();
snapshot.source = "live";
const run = snapshot.runs.find((entry) => entry.id === "r-102");
const item = snapshot.items.find((entry) => entry.id === run?.itemId);
if (!run || !item) throw new Error("The demo status has no r-102");
item.state = "merge_queue";
item.mergeQueue = { repository: "acme/platform", position: 2, total: 3, ahead: "ENG-101" };
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
        provider: { snapshot: () => snapshot },
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
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/runs/${run.id}`);
    await expect(
      page.getByRole("heading", { name: "Second in the acme/platform queue" }),
    ).toBeVisible();
    await expect(page.getByText("Waiting to merge · #2 in queue")).toBeVisible();
    await expect(page.getByText("ENG-101 merges first.")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(directory, `merge-queue-run-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Merge queue run page checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
