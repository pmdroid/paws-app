import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, readMergeSettings } from "../src/config";
import { handleAgentSettingsRequest, handleMergeSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/dashboard";
import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
const before = process.argv[3] === "before";
mkdirSync(directory, { recursive: true });
const configPath = join(mkdtempSync(join(tmpdir(), "paws-pr-checks-")), "config.toml");
const snapshot = fullStatusFixture();
snapshot.source = "live";
const audits: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    if (path === "/api/runners/accounts")
      return Response.json({
        revision: "r",
        canManage: true,
        agents: [],
        runners: [],
        accounts: [],
      });
    if (path === "/api/settings/skills")
      return Response.json({ skills: [], rollouts: [], agents: ["claude"], limitBytes: 1 });
    const options = {
      configPath,
      csrfToken: "ui-fixture",
      audit: (_action: string, subject: string) => audits.push(subject),
      repos: ["acme/platform"],
    };
    return (
      (await handleAgentSettingsRequest(request, options)) ??
      (await handleMergeSettingsRequest(request, options)) ??
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
        csrfToken: "ui-fixture",
      })) ??
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
const prefix = before ? "before" : "after";
try {
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      writeFileSync(
        configPath,
        `[agents.defaults.implementer]\nagent = "claude"\n\n[agents.defaults.reviewer]\nagent = "codex"\n\n[merge]\norder = "queue"\nmain_moved = "overlap"\nci_fix_attempts = 3\n`,
      );
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      const checks = page.getByRole("heading", { name: "Pull request checks" });

      await page.goto(`http://127.0.0.1:${server.port}/dashboard/settings/agents`);
      await expect(page.getByRole("heading", { name: "Global defaults" })).toBeVisible();
      if (!before) await expect(checks).toHaveCount(0);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `${prefix}-agents-${width}-${scheme}.png`),
        fullPage: true,
      });

      await page.goto(`http://127.0.0.1:${server.port}/dashboard/settings/merging`);
      await expect(page.locator("#merge-settings-form h2").first()).toHaveText("Merging");
      if (!before) {
        await expect(checks).toBeVisible();
        const order = await page
          .locator("#merge-settings-form h2")
          .evaluateAll((headings) => headings.map((heading) => heading.textContent));
        expect(order.indexOf("Pull request checks")).toBe(
          order.indexOf("Pull request comments") + 1,
        );
        const input = page.getByLabel("CI fix attempts");
        await expect(input).toHaveValue("3");
        await input.fill("5");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Merging settings saved.")).toBeVisible();
        await expect(input).toHaveValue("5");
        expect(readMergeSettings(loadConfigFile(configPath)).ciFixAttempts).toBe(5);
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await page.locator("#merge-pull-request-checks").screenshot({
          path: join(directory, `after-merging-checks-${width}-${scheme}.png`),
        });
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `${prefix}-merging-${width}-${scheme}.png`),
        fullPage: true,
      });
      await page.close();
    }
  expect(errors).toEqual([]);
  if (!before) expect(audits).toContain("CI fix attempts 3 → 5");
  console.log(`Pull request checks UI ${prefix} screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
