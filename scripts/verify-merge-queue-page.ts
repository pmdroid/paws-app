import { statusFixture } from "../src/web/test/fixtures";
// The Merge queue page with two repositories and a task whose repository is not known, against
// the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-merge-queue-page.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const at = (minutes: number) =>
  new Date(Date.parse(snapshot.generatedAt) - minutes * 60_000).toISOString();
const template = snapshot.items.find((item) => item.id === "ENG-101")!;
const add = (id: string, title: string, repository: string, pr: number, state = "merge_queue") =>
  snapshot.items.push({
    ...template,
    id,
    title,
    state: state as typeof template.state,
    runId: null,
    pr: { number: pr, url: `https://github.com/${repository}/pull/${pr}` },
    links: [],
  });
add("ENG-105", "CSV / JSON formatters", "acme/platform", 415);
add("ENG-107", "Fix export timezone for every report that crosses midnight", "acme/platform", 418);
add("ENG-120", "Landing copy", "acme/web", 31);
add("ENG-121", "Footer links", "acme/web", 32);
add("ENG-130", "Retention job", "acme/platform", 420, "running");
add("ENG-131", "Export audit trail", "acme/platform", 421);
const queue = { order: "queue", mainMoved: "ci", rule: null } as const;
const green = { order: "ci-green", mainMoved: "ci", rule: null } as const;
const entry = (
  itemId: string,
  repository: string | null,
  position: number | null,
  waitingFor: "ahead" | "ci" | "review",
  minutes: number,
  detail: string | null,
  settings: (typeof snapshot.mergeQueue)[number]["settings"] = queue,
) => ({
  position,
  itemId,
  repository,
  enqueuedAt: at(minutes),
  acceptedAt: at(minutes),
  waitingFor,
  detail,
  settings,
  steps: [],
});
snapshot.mergeQueue = [
  entry(
    "ENG-101",
    "acme/platform",
    1,
    "ci",
    50,
    "Branch updated onto main 9f1c2ab. CI 4 of 6 checks done.",
  ),
  entry("ENG-105", "acme/platform", 2, "ahead", 35, "Starts when #479 merges"),
  entry("ENG-107", "acme/platform", 3, "ahead", 10, "Starts when #415 merges", {
    order: "queue",
    mainMoved: "closeout",
    rule: "Bug",
  }),
  entry("ENG-120", "acme/web", null, "ci", 5, null, green),
  entry("ENG-121", "acme/web", null, "review", 125, null, green),
  entry("ENG-131", null, null, "ci", 3, null),
];
snapshot.mergeHistory = [
  ...(snapshot.mergeHistory ?? []),
  {
    itemId: "ENG-130",
    repository: "acme/platform",
    outcome: "back_with_agent",
    reason: "ci_failed",
    at: at(30),
    settings: queue,
  },
];

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
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/merge-queue`);
    await expect(page.getByRole("heading", { name: "acme/platform" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "acme/web" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Repository not known" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "unknown", exact: true })).toHaveCount(0);
    await expect(page.getByText("Back with the agent")).toBeVisible();
    await expect(page.getByText("Waiting for review")).toBeVisible();
    if (width > 768) {
      const navigation = page.getByRole("link", { name: /Merge queue/ });
      await expect(navigation).toHaveAttribute("aria-current", "page");
      await expect(navigation.getByLabel("6 waiting")).toHaveText("6");
      await expect(page.getByRole("columnheader", { name: "Detail" }).first()).toBeVisible();
    } else {
      await expect(page.getByRole("columnheader", { name: "Detail" }).first()).toBeHidden();
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(directory, `merge-queue-page-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Merge queue page checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
