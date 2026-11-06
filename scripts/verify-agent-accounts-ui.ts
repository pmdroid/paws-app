import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentSettings, loadConfigFile, writeAgentSettings } from "../src/config";
import { handleAgentSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/dashboard";
import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a proof directory");
const screenshotsOnly = process.argv.includes("--screenshots-only");
mkdirSync(directory, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "paws-agent-accounts-"));
const configPath = join(root, "config.toml");
const A = "01J00000000000000000000AAA";
const B = "01J00000000000000000000BBB";
const runner = {
  id: "01JRUNNER0000000000000000A",
  name: "pascal-paws",
  ownerUserId: "admin",
  ownerName: "Pascal",
  status: "online",
  hasRunWork: true,
  metrics: null,
  os: { id: "ubuntu", version: "24.04" },
  version: "1.0.0",
  idle: true,
  slots: { used: 0, total: 2 },
  running: [],
  agents: ["claude", "codex"].map((agent) => ({
    agent,
    status: "signed_in",
    checkedAt: Date.now(),
  })),
};
const ready = { state: "eligible", reason: null, detail: "Eligible.", until: null };
const account = (id: string, label: string, enabled: boolean) => ({
  id,
  agent: "claude",
  label,
  legacy: false,
  enabled,
  concurrency: 2,
  running: 0,
  sharedLimit: false,
  bindings: [
    {
      id: `binding-${id}`,
      runnerId: runner.id,
      runnerName: runner.name,
      ownedByYou: true,
      readiness: { ...ready, resetUnknown: false, low: false },
    },
  ],
});
const accounts = {
  revision: "accounts-1",
  canManage: true,
  agents: [
    { agent: "claude", name: "Claude Code", unsupported: null },
    { agent: "codex", name: "Codex", unsupported: null },
  ],
  runners: [{ id: runner.id, name: runner.name, ownedByYou: true }],
  accounts: [account(A, "Team Claude", true), account(B, "Backup Claude", true)],
};
const snapshot = fullStatusFixture();
snapshot.source = "live";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "admin",
        role: "admin",
        csrfToken: "fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/settings/skills")
      return Response.json({ skills: [], rollouts: [], agents: ["claude"], limitBytes: 1 });
    if (path === "/api/runners")
      return Response.json({ runners: [runner], serverVersion: null, agentVersions: [] });
    if (path === "/api/runners/accounts") return Response.json(accounts);
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    if (path === "/api/runners/vm") return Response.json({ available: false, vm: null });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    return (
      (await handleAgentSettingsRequest(request, { configPath, csrfToken: "fixture" })) ??
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
const base = `http://127.0.0.1:${server.port}/dashboard`;
try {
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      writeAgentSettings(configPath, {
        defaults: {
          implementer: { agent: "claude", model: null },
          reviewer: { agent: "codex", model: null },
          reviewerFallback: { agent: "claude", model: "opus" },
          accounts: { implementer: [A, B] },
        },
        projects: [{ repo: "acme/app", reviewer: { agent: "claude", model: "opus" } }],
      });
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${base}/settings/agents`);
      await expect(page.locator('[name="defaults-implementer-agent"]')).toBeVisible();
      await page.screenshot({
        path: join(directory, `agents-${width}-${scheme}.png`),
        fullPage: true,
      });
      await page.goto(`${base}/runners`);
      await expect(page.getByText(runner.name).first()).toBeVisible();
      if (!screenshotsOnly) {
        await expect(page.locator('[data-account-order="defaults-implementer"]')).toBeVisible();
        await expect(
          page.locator("#account-settings").getByText("Team Claude").first(),
        ).toBeVisible();
      }
      await page.waitForTimeout(300);
      await page.screenshot({
        path: join(directory, `runners-${width}-${scheme}.png`),
        fullPage: true,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (!screenshotsOnly) {
        await page.getByRole("button", { name: "Move Backup Claude up" }).click();
        await page
          .locator('[data-account-order="defaults-reviewerFallback"]')
          .getByRole("button", { name: "Add to order" })
          .click();
        await page.getByRole("button", { name: "Save order", exact: true }).click();
        await expect(
          page.getByRole("status").filter({ hasText: "Account order saved" }),
        ).toBeVisible();
        const saved = readAgentSettings(loadConfigFile(configPath));
        expect(saved.defaults.accounts).toEqual({ implementer: [B, A], reviewerFallback: [A] });
        expect(saved.projects).toEqual([
          { repo: "acme/app", reviewer: { agent: "claude", model: "opus" } },
        ]);
        await page.screenshot({
          path: join(directory, `runners-saved-${width}-${scheme}.png`),
          fullPage: true,
        });
        await page.goto(`${base}/settings/agents`);
        await expect(page.locator('[name="defaults-implementer-agent"]')).toBeVisible();
        expect(await page.locator("#account-settings, [data-account-order]").count()).toBe(0);
        await expect(
          page.getByText("Accounts and their order are on the Runners page."),
        ).toBeVisible();
      }
      await page.close();
    }
  expect(errors).toEqual([]);
  writeFileSync(join(directory, "observations.json"), JSON.stringify({ errors }, null, 2));
  console.log(`Agent accounts checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
