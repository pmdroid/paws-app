import {
  fixtureProvider,
  fullStatusFixture,
  type FullStatus,
} from "../src/dashboard/test/fixtures";
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: verify-overview-ui.ts <screenshot dir> [--before]");
const before = process.argv.includes("--before");
mkdirSync(directory, { recursive: true });

type StatusItem = FullStatus["items"][number];
type StatusItemEvent = NonNullable<StatusItem["timeline"]>[number];

const full = fullStatusFixture();
full.source = "live";
const at = (minutes: number) =>
  new Date(Date.parse(full.generatedAt) - minutes * 60_000).toISOString();
const byId = (id: string) => full.items.find((entry) => entry.id === id)!;
const event = (minutes: number, from: string, to: string, name: string): StatusItemEvent => ({
  at: at(minutes),
  kind: "transition",
  from,
  to,
  event: name,
  reason: null,
  actor: null,
});
const running = (runner: string, minutes: number, activeMinutes: number) => ({
  doing: { kind: "running" as const, runners: [runner], since: at(minutes), stalled: false },
  activeMs: activeMinutes * 60_000,
});
const extra = (id: string, title: string, patch: Partial<StatusItem>): StatusItem => ({
  ...byId("ENG-102"),
  id,
  title,
  runId: null,
  branch: null,
  timeline: [],
  pr: null,
  links: [{ label: "Linear", href: `https://linear.app/acme/issue/${id}` }],
  ...patch,
});

Object.assign(byId("ENG-102"), {
  timeline: [
    event(80, "queued", "running", "dispatched"),
    event(40, "running", "verifying", "turn_ended"),
    event(30, "verifying", "merge_queue", "closeout_accepted"),
    { ...event(9, "merge_queue", "queued", "restart"), kind: "restart", reason: "conflict" },
    event(8, "queued", "running", "dispatched"),
  ],
  ...running("agentbox", 8, 74),
});
Object.assign(byId("ENG-101"), {
  mergeQueue: { position: 1, total: 1, ahead: null, repository: "acme/platform" },
});
Object.assign(byId("ENG-104"), { held: { reason: "blocked", blockers: ["ENG-101", "ENG-103"] } });
full.items.push(
  extra("ENG-105", "Rate-limit export downloads", {
    state: "verifying",
    agent: "Claude",
    ...running("agentbox", 6, 52),
  }),
  extra("ENG-106", "Audit log filters by actor", {
    state: "running",
    agent: "Codex",
    ...running("runner-2", 21, 21),
  }),
  extra("ENG-107", "Export retention settings page", {
    state: "queued",
    agent: "Claude",
    queue: { position: 1, busySlots: 4, totalSlots: 4 },
    doing: { kind: "slot", runners: [], since: at(12), stalled: false },
    activeMs: 0,
  }),
  extra("ENG-98", "Audit export CSV header order", {
    state: "merged",
    agent: "Claude",
    pr: { number: 471, url: "https://github.com/acme/platform/pull/471" },
    timeline: [event(190, "merge_queue", "merged", "merged")],
  }),
);
Object.assign(byId("ENG-99"), { timeline: [event(55, "merge_queue", "merged", "merged")] });

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
        provider: fixtureProvider(full),
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
const prefix = before ? "before" : "after";
try {
  for (const [width, scheme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`http://127.0.0.1:${server.port}/status`);
    await expect(page.getByRole("heading", { level: 2, name: /Needs you/ })).toBeVisible();
    if (!before) {
      await expect(page.locator("h1")).toHaveCount(1);
      const progress = page.getByRole("region", { name: /In progress/ });
      for (const [id, phase] of [
        ["ENG-102", "Fixing merge conflicts"],
        ["ENG-105", "Checking"],
        ["ENG-106", "Implementing"],
        ["ENG-101", "Waiting to merge"],
      ])
        await expect(progress.locator(`[data-item="${id}"]`)).toContainText(phase);
      await expect(page.getByRole("region", { name: /Queued/ })).toContainText(
        "blocked by ENG-101, ENG-103",
      );
      await expect(page.getByRole("region", { name: /Recently merged/ })).toContainText(
        "Audit event schema v2",
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.screenshot({
      path: join(directory, `${prefix}-overview-${width}-${scheme}.png`),
      fullPage: true,
    });
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Overview checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
