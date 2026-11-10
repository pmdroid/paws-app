// The Runners page's Agents table: sign-in, usage and extra usage in one place, at 1440 and 390 px.
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
  agents: [
    {
      agent: "claude",
      status: "signed_in",
      checkedAt: now,
      limitsAt: now - 4 * 60_000,
      limits: [
        { window: "5-hour", usedPercent: 62, resetsAt: now + 3 * 3_600_000 },
        { window: "weekly", usedPercent: 3, resetsAt: now + 5 * 86_400_000 },
      ],
    },
    { agent: "codex", status: "signed_out", checkedAt: now },
    {
      agent: "grok",
      status: "extra_usage",
      checkedAt: now,
      extraUsage: true,
      resetsAt: now + 3_600_000,
      limits: [{ window: "5-hour", usedPercent: 100, resetsAt: now + 3_600_000 }],
    },
    { agent: "opencode", status: "unknown", checkedAt: null },
  ],
};
const posts: { path: string; body: unknown }[] = [];
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
        csrfToken: "csrf",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: [runner], serverVersion: null, agentVersions: [] });
    if (path === `/api/runners/${runner.id}/policy`)
      return Response.json({ ownerUserId: "admin", sharing: 0 });
    if (path.endsWith("/extra-usage") && request.method === "POST") {
      posts.push({ path, body: await request.json() });
      return Response.json({ ok: true });
    }
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
      const table = page.getByRole("table", { name: `Agents on ${runner.name}` });
      await expect(table).toBeVisible();
      await expect(table.locator('tr[data-agent="claude"]')).toContainText(
        /5-hour 62% · resets \d{1,2}:\d{2}\s?[AP]M · weekly 3% · resets \w{3}, \w{3} \d{1,2}/,
      );
      await expect(table.locator('tr[data-agent="grok"]')).toContainText("Running on extra usage");
      await expect(
        page.getByRole("button", { name: `Sign in to Codex on ${runner.name}` }),
      ).toBeVisible();
      await expect(page.getByLabel("Agent sign-in and usage")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: join(directory, `runner-${width}-${scheme}.png`),
        fullPage: true,
      });
      await table.locator('tr[data-agent="claude"] input[type="checkbox"]').click();
      await expect(page.getByText("Extra usage saved.")).toBeVisible();
      await page.close();
    }
  expect(posts).toEqual(
    Array.from({ length: 4 }, () => ({
      path: `/api/runners/${runner.id}/agents/claude/extra-usage`,
      body: { extraUsage: true },
    })),
  );
  expect(errors).toEqual([]);
  writeFileSync(join(directory, "observations.json"), JSON.stringify({ errors, posts }, null, 2));
  console.log(`Runner agents checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
