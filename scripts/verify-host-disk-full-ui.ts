import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";
// The full-disk notice on the issue page and the Merge queue page, against the real status
// handler.
// Usage: bun run build:dashboard && bun --no-env-file scripts/verify-host-disk-full-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const reason = "Paws's host is out of disk space (/tmp, 12 MB left)";
const snapshot = fullStatusFixture();
snapshot.source = "live";
snapshot.items.find((item) => item.id === "ENG-101")!.hostDiskFull = reason;
snapshot.mergeQueue.find((entry) => entry.itemId === "ENG-101")!.detail = reason;

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
        provider: fixtureProvider(snapshot),
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
  for (const [name, path] of [
    ["issue", "/dashboard/issues/ENG-101"],
    ["merge-queue", "/dashboard/merge-queue"],
  ] as const) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`http://127.0.0.1:${server.port}${path}`);
      const notice = page.getByText(reason, { exact: false }).first();
      if (name === "merge-queue" && width === 390) await expect(notice).toBeAttached();
      else await expect(notice).toBeVisible();
      if (name === "issue")
        await expect(page.locator("[data-host-disk-full]")).toContainText(
          "Paws retries when space is free.",
        );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) throw new Error(`${name} at ${width} px overflows by ${overflow} px`);
      if (name === "issue") await notice.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(directory, `host-disk-full-${name}-${width}.png`),
        fullPage: false,
      });
      await page.close();
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
  server.stop(true);
}
