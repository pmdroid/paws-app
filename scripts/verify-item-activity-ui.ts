import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";
import type { StatusItem } from "../src/web/src/contract";
import { fixtureProvider, fullStatusFixture } from "../src/web/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const MIN = 60_000;
const full = fullStatusFixture();
full.source = "live";
const now = Date.parse(full.generatedAt);
const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();
const base = full.items.find((item) => item.id === "ENG-102")!;
base.doing = { kind: "running", runners: ["agentbox"], since: null };
base.activeMs = 52 * MIN;
const extra = (id: string, title: string, patch: Partial<StatusItem>): StatusItem => ({
  ...base,
  id,
  title,
  runId: null,
  ...patch,
});
full.items.push(
  extra("ENG-105", "Pinned run waits for agentbox", {
    doing: { kind: "slot", runners: ["agentbox"], since: ago(26) },
    activeMs: 114 * MIN,
  }),
  extra("ENG-106", "Usage limit pause", {
    doing: {
      kind: "paused",
      runners: [],
      since: ago(12),
      until: new Date(now + 48 * MIN).toISOString(),
      agent: "Claude",
    },
    activeMs: 37 * MIN,
  }),
  extra("ENG-107", "Deadlocked Closeout", {
    state: "verifying",
    doing: { kind: "slot", runners: ["agentbox", "spare"], since: ago(41), stalled: true },
    activeMs: 12 * MIN,
  }),
);
const provider = fixtureProvider(full);
const session = (id: string, identifier: string, title: string, movable: boolean) => ({
  runId: id,
  identifier,
  title,
  phase: "working",
  startedAt: now - 16 * 60 * MIN,
  movable,
  move: null,
});
const runner = {
  id: "01JRUNNER0000000000000000A",
  name: "agentbox",
  ownerUserId: "owner",
  ownerName: "Pascal",
  status: "active",
  hasRunWork: true,
  metrics: null,
  os: { id: "ubuntu", version: "24.04" },
  version: "0.1.44",
  idle: false,
  slots: { used: 4, total: 2 },
  running: [
    session("run-943", "PAS-943", "Live agent turn", true),
    session("run-950", "PAS-950", "Another live agent turn", true),
    session("run-944", "PAS-944", "Pinned between commands", false),
    session("run-956", "PAS-956", "Also pinned between commands", false),
  ],
  agents: [{ agent: "claude", status: "signed_in", checkedAt: now }],
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
        csrfToken: "fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: [runner], serverVersion: null, agentVersions: [] });
    if (path.endsWith("/policy")) return Response.json({ ownerUserId: "owner", sharing: 0 });
    if (path === "/api/runners/vm") return Response.json({ available: false, vm: null });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    return (
      (await handleStatusRequest(request, { provider, csrfToken: "fixture" })) ??
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
const origin = `http://127.0.0.1:${server.port}`;
try {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      const shot = async (name: string) => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 0) throw new Error(`${name} ${scheme} ${width} overflows by ${overflow}px`);
        await page.screenshot({
          path: join(directory, `${name}-${scheme}-${width}.png`),
          fullPage: true,
        });
      };

      await page.goto(`${origin}/status`);
      await expect(page.getByText("Running on agentbox").first()).toBeVisible();
      await expect(page.getByText("Waiting for a slot on agentbox").first()).toBeVisible();
      await expect(
        page.getByText("Waiting for a slot on agentbox · 1.9 h active · waiting 26 min").first(),
      ).toBeVisible();
      await expect(page.getByText("Paused: Claude usage limit until 23:03 UTC")).toBeVisible();
      await expect(page.getByText("Stalled").first()).toBeVisible();
      await shot("activity-overview");

      await page.goto(`${origin}/status/issues`);
      await expect(page.getByText("Stalled").first()).toBeVisible();
      await shot("activity-issues");

      await page.goto(`${origin}/status/issues/ENG-105`);
      await expect(
        page.getByText("Waiting for a slot on agentbox · 1.9 h active · waiting 26 min"),
      ).toBeVisible();
      await expect(page.locator(".run-heading .st").first()).toHaveText("Waiting for a slot");
      await shot("activity-issue-page");

      await page.goto(`${origin}/status/runners/${runner.id}`);
      await expect(
        page.getByText("2 running · 2 waiting for this runner · 2 slots").first(),
      ).toBeVisible();
      await expect(page.getByText("Waiting for this runner", { exact: true })).toHaveCount(2);
      await shot("activity-runner");
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Activity checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
