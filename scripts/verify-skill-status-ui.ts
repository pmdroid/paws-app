// Installed skills on the runner page, the run page and Settings → Agents → Skills.
// Usage: bun run build:status && bun --no-env-file scripts/verify-skill-status-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { demoStatus, handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const commit = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const snapshot = demoStatus();
snapshot.source = "live";
snapshot.runs[0]!.setup = {
  skills: [
    { name: "impeccable", version: "2.4.1", installing: false },
    { name: "review-paws", version: commit, installing: true },
  ],
  hooks: [{ name: "Paws Closeout", event: "stop" }],
};
const now = Date.now();
const runnerId = "01JRUNNER0000000000000000A";
const runner = {
  id: runnerId,
  name: "goldbox",
  ownerUserId: "owner",
  status: "active",
  metrics: {
    cpuPercent: 18,
    cpuCount: 8,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryAvailableBytes: 20 * 1024 ** 3,
    load1: 0.8,
    load5: 0.6,
    load15: 0.5,
    diskTotalBytes: 500 * 1024 ** 3,
    diskFreeBytes: 300 * 1024 ** 3,
    reportedAt: now,
  },
  os: { id: "ubuntu", version: "24.04" },
  version: "0.1.26",
  idle: true,
  slots: { used: 0, total: 2 },
  skills: [
    {
      name: "impeccable",
      version: "2.4.1",
      installedVersion: "2.4.1",
      state: "up_to_date",
      error: null,
      reportedAt: now,
    },
    {
      name: "review-paws",
      version: commit,
      installedVersion: null,
      state: "installing",
      error: null,
      reportedAt: null,
    },
    {
      name: "polish",
      version: "1.3.0",
      installedVersion: "1.2.0",
      state: "out_of_date",
      error: null,
      reportedAt: now,
    },
    {
      name: "a-skill-with-a-rather-long-name-for-a-phone",
      version: "0.9.0",
      installedVersion: null,
      state: "failed",
      error:
        "Skill a-skill-with-a-rather-long-name-for-a-phone 0.9.0 failed its checksum and was not installed.",
      reportedAt: now,
    },
  ],
};
const pin = (name: string, version: string, source: unknown, agents: string[]) => ({
  name,
  source,
  version,
  sha256: "a".repeat(64),
  sizeBytes: 2048,
  agents,
  removedAt: null,
});
const listing = {
  agents: ["claude", "codex", "grok"],
  limitBytes: 50 * 1024 * 1024,
  skills: [
    pin("impeccable", "2.4.1", { kind: "npm", package: "impeccable" }, ["claude", "codex"]),
    pin("review-paws", commit, { kind: "git", url: "https://github.com/pmdroid/skills" }, [
      "claude",
    ]),
    pin("polish", "1.3.0", { kind: "npm", package: "polish" }, ["claude"]),
  ],
  rollouts: [
    { name: "impeccable", total: 2, upToDate: 2, installing: [], outOfDate: [], failed: [] },
    {
      name: "review-paws",
      total: 2,
      upToDate: 1,
      installing: ["goldbox"],
      outOfDate: [],
      failed: [],
    },
    {
      name: "polish",
      total: 2,
      upToDate: 0,
      installing: [],
      outOfDate: ["goldbox"],
      failed: ["a-runner-with-a-long-hostname"],
    },
  ],
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "ui-fixture",
        workspaceId: "kyku",
        workspaces: [{ id: "kyku", name: "Kyku" }],
        user: { name: "Owner", email: "owner@example.invalid" },
      });
    if (path === "/api/settings/skills") return Response.json(listing);
    if (path === "/api/settings/agents")
      return Response.json({
        defaults: {
          implementer: { agent: "claude", model: null },
          reviewer: { agent: "codex", model: null },
        },
        projects: [],
      });
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    if (path === "/api/runners")
      return Response.json({
        setupRequired: false,
        workspaceReady: true,
        serverVersion: "0.1.26",
        runners: [runner],
      });
    if (path.startsWith("/api/runners/usage")) return Response.json({ usage: [] });
    if (path.endsWith("/policy")) return Response.json({ ownerUserId: "owner", sharing: 0 });
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
const screens = [
  {
    name: "runner",
    path: `/status/runners/${runnerId}`,
    ready: "Skill a-skill-with-a-rather-long-name-for-a-phone 0.9.0 failed its checksum",
    section: `[aria-labelledby="runner-${runnerId}-skills"]`,
  },
  {
    name: "run",
    path: `/status/runs/${snapshot.runs[0]!.id}`,
    ready: "The run may have had the earlier version.",
    section: ".run-setup, [aria-labelledby='setup-heading']",
  },
  {
    name: "settings",
    path: "/status/settings/agents",
    ready: "2 of 2 up to date",
    section: "table:has(th:text('Runners'))",
  },
];
try {
  for (const width of [1440, 390]) {
    for (const screen of screens) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`http://127.0.0.1:${server.port}${screen.path}`);
      await expect(page.getByText(screen.ready).first()).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await expect(page.locator(screen.section).first()).toBeVisible();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `${screen.name}-${width}.png`),
        fullPage: true,
      });
      await page.close();
    }
  }
  expect(errors).toEqual([]);
  console.log(`Skill status checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
