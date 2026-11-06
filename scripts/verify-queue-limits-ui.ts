import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../src/db";
import {
  handleAgentSettingsRequest,
  handleCheckoutSettingsRequest,
  handleHookSettingsRequest,
  handleTimeLimitSettingsRequest,
} from "../src/settings";
import { handleStatusRequest } from "../src/dashboard";
import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "paws-queue-limits-"));
const configPath = join(root, "config.toml");
const db = openDatabase(join(root, "paws.sqlite"));
migrate(db);
const snapshot = fullStatusFixture();
snapshot.source = "live";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    if (path === "/api/runners/accounts")
      return Response.json({
        revision: "fixture",
        canManage: true,
        agents: [{ agent: "claude", name: "Claude Code", unsupported: null }],
        runners: [],
        accounts: [],
      });
    if (path === "/api/settings/skills")
      return Response.json({
        skills: [],
        rollouts: [],
        agents: ["claude", "codex"],
        limitBytes: 1,
      });
    if (path === "/api/settings/hooks")
      return handleHookSettingsRequest(request, { db, csrfToken: "fixture", audit: () => {} });
    return (
      (await handleCheckoutSettingsRequest(request, { configPath, csrfToken: "fixture" })) ??
      (await handleAgentSettingsRequest(request, { configPath, csrfToken: "fixture" })) ??
      (await handleTimeLimitSettingsRequest(request, {
        configPath,
        csrfToken: "fixture",
        audit: () => {},
      })) ??
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
        csrfToken: "fixture",
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
const base = `http://127.0.0.1:${server.port}/dashboard/settings`;
try {
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      writeFileSync(configPath, "");
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });

      await page.goto(`${base}/agents`);
      await expect(page.getByRole("heading", { name: "Global defaults" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Queue", exact: true })).toHaveCount(0);
      await expect(page.locator("#time-limit-settings, #queue-settings")).toHaveCount(0);
      await page.screenshot({
        path: join(directory, `agents-${width}-${scheme}.png`),
        fullPage: true,
      });

      await page.goto(`${base}/limits`);
      await expect(
        page.getByText("How long work may wait and run, and how much runs at once."),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Time limits" })).toBeVisible();
      await expect(page.locator("#queue-start-timeout")).toHaveValue("24");
      await page.locator("#queue-start-timeout").fill("6");
      await page.locator("#queue-owner-cap").fill("2");
      await page.getByRole("button", { name: "Save queue settings" }).click();
      await expect(page.locator("#queue-settings").getByText("Saved")).toBeVisible();
      await page.locator("#time-default-implementation").fill("240");
      await page.getByRole("button", { name: "Save time limits" }).click();
      await expect(page.locator("#time-limit-settings").getByText("Saved")).toBeVisible();
      const config = readFileSync(configPath, "utf8");
      expect(config).toContain("start_timeout_hours = 6");
      expect(config).toContain("max_running_per_owner = 2");
      expect(config).toContain("implementation_minutes = 240");

      await page.reload();
      await expect(page.locator("#queue-start-timeout")).toHaveValue("6");
      await expect(page.locator("#queue-owner-cap")).toHaveValue("2");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(directory, `limits-${width}-${scheme}.png`),
        fullPage: true,
      });
      await page.close();
    }
  expect(errors).toEqual([]);
} finally {
  await browser.close();
  server.stop(true);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
