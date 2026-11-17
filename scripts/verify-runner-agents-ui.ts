// The runner card's Agents block: installed coding agents and a link to Agent accounts, at 1440 and 390 px.
// Usage: bun run build:dashboard && bun scripts/verify-runner-agents-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";
import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a proof directory");
mkdirSync(directory, { recursive: true });
const now = Date.now();
const runner = {
  id: "01JRUNNER0000000000000000A",
  name: "pascal-paws",
  ownerUserId: "admin",
  ownerName: "Pascal",
  status: "active",
  hasRunWork: true,
  metrics: null,
  os: { id: "ubuntu", version: "24.04" },
  version: "1.0.0",
  idle: true,
  slots: { used: 0, total: 2 },
  running: [],
  codingAgents: [
    { agent: "claude", current: "2.0.14", pending: null, reportedAt: now },
    {
      agent: "codex",
      current: "0.40.0",
      pending: {
        version: "0.41.0",
        status: "installing",
        sessions: null,
        error: null,
        requestedAt: now,
      },
      reportedAt: now,
    },
    { agent: "grok", current: "0.1.9", pending: null, reportedAt: now },
  ],
};
const requests: string[] = [];
const snapshot = fullStatusFixture();
snapshot.source = "live";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/api/auth/session")
      return Response.json({
        userId: "admin",
        role: "admin",
        csrfToken: "csrf",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/runners")
      return Response.json({
        runners: [runner],
        serverVersion: null,
        agentVersions: [
          { agent: "claude", offered: "2.0.20", refused: [], checkedAt: now },
          { agent: "codex", offered: "0.41.0", refused: [], checkedAt: now },
          { agent: "grok", offered: "0.1.9", refused: [], checkedAt: now },
        ],
      });
    if (path === `/api/runners/${runner.id}/policy`)
      return Response.json({ ownerUserId: "admin", sharing: 0 });
    if (path === "/api/workspaces/repositories") return Response.json({ repositories: [] });
    if (path === "/api/runners/vm") return Response.json({ available: false, vm: null });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
        csrfToken: "csrf",
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
const base = `http://127.0.0.1:${server.port}/dashboard`;
try {
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${base}/runners`);
      await expect(page.getByText(runner.name).first()).toBeVisible();
      await page.waitForTimeout(300);
      expect(
        await page.locator("#agent-accounts, #account-settings, [data-account-order]").count(),
      ).toBe(0);
      await expect(page.getByText("Which account would new work use?")).toHaveCount(0);
      await page.screenshot({
        path: join(directory, `runners-${width}-${scheme}.png`),
        fullPage: true,
      });
      await page.goto(`${base}/runners/${runner.id}`);
      const block = page.locator(`section[aria-labelledby="runner-${runner.id}-agents"]`);
      const list = block.getByRole("list", { name: `Agents on ${runner.name}` });
      await expect(list.locator('[data-coding-agent="claude"]')).toContainText("2.0.14");
      await expect(list.locator('[data-coding-agent="claude"]')).toContainText("Update available");
      await expect(list.locator('[data-coding-agent="codex"]')).toContainText("Installing");
      await expect(list.locator('[data-coding-agent="grok"]')).toContainText("Up to date");
      await expect(block.locator("table, input[type=checkbox]")).toHaveCount(0);
      await expect(list).not.toContainText(/Sign|Usage|usage/);
      await expect(block.getByRole("link", { name: "Settings › Agent accounts" })).toHaveAttribute(
        "href",
        "/dashboard/settings/agent-accounts",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: join(directory, `runner-${width}-${scheme}.png`),
        fullPage: true,
      });
      await page.close();
    }
  expect(requests.filter((path) => path.endsWith("/extra-usage"))).toEqual([]);
  expect(errors).toEqual([]);
  writeFileSync(
    join(directory, "observations.json"),
    JSON.stringify({ errors, requests }, null, 2),
  );
  console.log(`Runner agents checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
