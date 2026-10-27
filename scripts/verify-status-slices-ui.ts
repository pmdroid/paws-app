// Each dashboard page asks /api/status only for its slices, an unchanged list is a 304, Settings
// and Runners load no status, and a hidden tab stops polling.
// Usage: bun run build:status && bun --no-env-file scripts/verify-status-slices-ui.ts <screenshot dir>
import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { statusFixture } from "../src/web/test/fixtures";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
const served: { path: string; status: number }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/session") return new Response(null, { status: 404 });
    if (url.pathname === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    const response =
      (await handleStatusRequest(request, {
        provider: { snapshot: () => ({ ...snapshot, generatedAt: new Date().toISOString() }) },
        csrfToken: "ui-fixture",
      })) ?? new Response(null, { status: 404 });
    if (url.pathname === "/api/status")
      served.push({ path: `${url.pathname}${url.search}`, status: response.status });
    return response;
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const base = `http://127.0.0.1:${server.port}/status`;
const errors: string[] = [];

async function visit(page: Page, path: string): Promise<{ path: string; status: number }[]> {
  served.length = 0;
  await page.goto(`${base}${path}`);
  await page.waitForTimeout(800);
  return [...served];
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (value ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });

    const overview = await visit(page, "/");
    await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
    expect(overview.map((entry) => entry.path)).toEqual([
      "/api/status?slices=items,questions,mergeQueue,intake",
    ]);
    await page.screenshot({ path: join(directory, `overview-${width}.png`), fullPage: true });

    const queue = await visit(page, "/merge-queue");
    await expect(page.getByText(/Accepted pull requests merge one at a time/)).toBeVisible();
    expect(queue.map((entry) => entry.path)).toEqual([
      "/api/status?slices=items,mergeQueue,mergeHistory",
    ]);
    await page.screenshot({ path: join(directory, `merge-queue-${width}.png`), fullPage: true });

    for (const path of ["/settings/agents", "/runners"]) {
      expect(await visit(page, path)).toEqual([]);
      await page.waitForTimeout(5500);
      expect(served).toEqual([]);
    }
    await page.screenshot({ path: join(directory, `runners-${width}.png`), fullPage: true });

    if (width === 1440) {
      // The overview polls, and an unchanged list answers 304.
      await visit(page, "/");
      await page.waitForTimeout(5500);
      expect(served.map((entry) => entry.status)).toEqual([200, 304]);

      // A hidden tab makes no requests and loads once when shown again.
      await setHidden(page, true);
      served.length = 0;
      await page.waitForTimeout(11_000);
      expect(served).toEqual([]);
      await setHidden(page, false);
      await page.waitForTimeout(500);
      expect(served).toHaveLength(1);
    }
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Status slice checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
