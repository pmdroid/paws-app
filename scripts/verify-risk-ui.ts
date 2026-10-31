import { fullStatusFixture, itemDetail, statusList } from "../src/web/test/fixtures";
// The Risk card on the issue page from the item detail, and Settings › Merging › High-risk paths
// against the real settings handler and a temporary config.toml: edit, save, reload, and the
// repository file read-only. Light and dark, at 1440 and 390 px.
// Usage: bun run build:status && bun --no-env-file scripts/verify-risk-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { highRiskPaths, loadConfigFile, readMergeSettings } from "../src/config";
import { handleMergeSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/web";
import type { StatusItemDetail, StatusItemRisk } from "../src/web/src/contract";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const HEAD = "7f65200".padEnd(40, "a");
const full = fullStatusFixture();
const snapshot = statusList(full);
const RISKS: Record<string, StatusItemRisk> = {
  "ENG-101": {
    tier: "high",
    head: HEAD,
    base: "b".repeat(40),
    classifiedAt: "2026-10-27T01:00:00.000Z",
    paths: [
      { path: "src/auth/session.ts", lists: ["settings", "file"] },
      { path: "infra/terraform/modules/session-token-rotation/main.tf", lists: ["file"] },
    ],
    securityReview: { state: "passed", detail: null, head: HEAD },
  },
  "ENG-102": {
    tier: "normal",
    head: HEAD,
    base: "b".repeat(40),
    classifiedAt: "2026-10-27T01:00:00.000Z",
    paths: [],
    securityReview: { state: "skipped", detail: "no changed path matches", head: HEAD },
  },
};
const detail = (id: string): StatusItemDetail | null =>
  full.items.some((item) => item.id === id)
    ? { ...itemDetail(full, id), risk: RISKS[id] ?? null }
    : null;

const configPath = join(mkdtempSync(join(tmpdir(), "paws-risk-")), "config.toml");
let riskGateOn = true;
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
        riskGate: { on: riskGateOn, reason: "The risk gate needs an HTTPS public URL." },
        csrfToken: "ui-fixture",
        repos: ["acme/platform", "acme/web", "acme/docs"],
        highRiskFile: async (repo) =>
          repo === "acme/platform"
            ? { commit: "4b317d5".padEnd(40, "c"), paths: ["infra/**", "deploy/**"] }
            : repo === "acme/web"
              ? { commit: "9f1c2aa".padEnd(40, "d"), paths: null }
              : null,
      })) ??
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot, item: detail },
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
const fits = (page: import("@playwright/test").Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
try {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      riskGateOn = true;
      writeFileSync(configPath, '[merge]\norder = "queue"\nmain_moved = "closeout"\n');
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });

      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-101`);
      const card = page.locator("#risk-tier");
      await expect(card.getByRole("heading", { name: "Risk" })).toBeVisible();
      await expect(card).toContainText("High");
      await expect(card).toContainText("changes 2 high-risk paths");
      await expect(card).toContainText("Matched by Settings › Merging and .paws/high-risk-paths");
      await expect(card).toContainText("Security review ran: passed.");
      await fits(page);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: join(directory, `risk-high-${scheme}-${width}.png`) });

      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-102`);
      await expect(card).toContainText("Normal");
      await expect(card).toContainText("Security review skipped: no high-risk path.");
      await fits(page);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: join(directory, `risk-normal-${scheme}-${width}.png`) });

      await page.goto(`http://127.0.0.1:${server.port}/status/settings/merging`);
      await expect(page.getByRole("heading", { name: "High-risk paths" })).toBeVisible();
      const automatic = page.getByRole("checkbox", {
        name: "Let high-risk changes through when both reviews are clean",
      });
      await expect(automatic).not.toBeChecked();
      await automatic.check();
      const platform = page.locator(".settings-project", {
        has: page.getByRole("heading", { name: "acme/platform" }),
      });
      await expect(platform.locator("code", { hasText: "infra/**" })).toBeVisible();
      await expect(platform.locator("textarea")).toHaveValue("");
      await platform.getByLabel("Paws settings").fill("src/auth/**\n.github/workflows/**\n");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Merging settings saved.")).toBeVisible();
      expect(highRiskPaths(readMergeSettings(loadConfigFile(configPath)), "acme/platform")).toEqual(
        ["src/auth/**", ".github/workflows/**"],
      );
      await page.reload();
      await expect(automatic).toBeChecked();
      expect(readMergeSettings(loadConfigFile(configPath)).autoApproveHighRisk).toBe(true);
      await expect(platform.locator("textarea")).toHaveValue("src/auth/**\n.github/workflows/**");
      await expect(platform).toContainText("Read-only, from origin/main at 4b317d5.");
      await expect(page.getByText("No file on origin/main at 9f1c2aa.")).toBeVisible();
      await expect(page.getByText("Paws has no copy of this repository yet.")).toBeVisible();
      await fits(page);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `high-risk-paths-${scheme}-${width}.png`),
        fullPage: true,
      });
      riskGateOn = false;
      await page.reload();
      await expect(automatic).toBeDisabled();
      await expect(
        page.getByText("Turn on the risk gate before changing this setting.", { exact: false }),
      ).toBeVisible();
      await fits(page);
      await page.screenshot({
        path: join(directory, `risk-gate-off-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Risk checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
