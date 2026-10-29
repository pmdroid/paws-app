import { fixtureProvider, fullStatusFixture } from "../src/web/test/fixtures";
// Settings → Merging lists the conflict-prone files read-only, and an issue the scheduler holds
// for one shows which item it waits for.
// Usage: bun run build:status && bun --no-env-file scripts/verify-hot-files-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMergeSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const snapshot = fullStatusFixture();
snapshot.source = "live";
const held = snapshot.items[0]!;
const provider = fixtureProvider(snapshot);
held.state = "queued";
held.blockers = [];
delete held.queue;
held.held = { reason: "overlap", blockers: ["PAS-785"], files: ["src/web/src/live/provider.ts"] };
const configPath = join(mkdtempSync(join(tmpdir(), "paws-hot-files-")), "config.toml");
writeFileSync(configPath, `[merge]\norder = "queue"\nmain_moved = "ci"\n`);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    return (
      (await handleMergeSettingsRequest(request, {
        configPath,
        csrfToken: "ui-fixture",
        hotFiles: () => [
          {
            repository: "acme/platform",
            path: "src/merge/advance-harness.ts",
            conflicts: 6,
            items: ["PAS-784"],
          },
          {
            repository: "acme/platform",
            path: "src/web/src/live/provider.ts",
            conflicts: 4,
            items: ["PAS-785", "PAS-761"],
          },
          {
            repository: "acme/platform",
            path: "src/web/src/server/handler.ts",
            conflicts: 3,
            items: ["PAS-763"],
          },
        ],
      })) ??
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
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/settings/merging`);
    const section = page.locator("#merge-hot-files");
    await expect(section.getByRole("heading", { name: "Conflict-prone files" })).toBeVisible();
    await expect(section).toContainText("src/web/src/live/provider.ts");
    await expect(section).toContainText("4 conflicts (PAS-785, PAS-761)");
    await expect(section.locator("textarea, input, select")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(directory, `hot-files-${width}.png`) });

    await page.goto(`http://127.0.0.1:${server.port}/status/issues/${held.id}`);
    await expect(
      page.getByText("Held: waiting for PAS-785 to merge (both change provider.ts)").first(),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: join(directory, `issue-held-${width}.png`) });
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Hot-file checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
