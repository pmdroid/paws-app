import { fixtureProvider, fullStatusFixture } from "../src/web/test/fixtures";
// A merge queue whose first task is re-checking: the Merge queue page and that task's issue page
// show it keeps its place, and the ready task behind it moves. Against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-merge-recheck-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = fullStatusFixture();
snapshot.source = "live";
const at = (minutes: number) =>
  new Date(Date.parse(snapshot.generatedAt) - minutes * 60_000).toISOString();
const template = snapshot.items.find((item) => item.id === "ENG-101")!;
template.state = "verifying";
template.mergeQueue = {
  repository: "acme/platform",
  position: 1,
  total: 3,
  ahead: null,
  rechecking: true,
};
const add = (id: string, title: string, pr: number, ahead: string | null, position: number) =>
  snapshot.items.push({
    ...template,
    id,
    title,
    state: "merge_queue",
    runId: null,
    pr: { number: pr, url: `https://github.com/acme/platform/pull/${pr}` },
    links: [],
    mergeQueue: { repository: "acme/platform", position, total: 3, ahead },
  });
add("ENG-105", "CSV / JSON formatters", 415, null, 2);
add("ENG-107", "Fix export timezone", 418, "ENG-105", 3);
const settings = { order: "queue", mainMoved: "ci", rule: null } as const;
const entry = (
  itemId: string,
  position: number,
  waitingFor: "ahead" | "ci" | "closeout",
  minutes: number,
  detail: string | null,
) => ({
  position,
  itemId,
  repository: "acme/platform",
  enqueuedAt: at(minutes),
  acceptedAt: at(minutes),
  waitingFor,
  detail,
  settings,
  steps: [],
});
snapshot.mergeQueue = [
  entry("ENG-101", 1, "closeout", 50, "Re-checking, keeps its place."),
  entry("ENG-105", 2, "ci", 35, "Waiting for CI on the candidate commit."),
  entry("ENG-107", 3, "ahead", 10, "Starts when #415 merges"),
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
        provider: fixtureProvider(snapshot),
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
    // Narrow screens drop the Detail column and keep the step.
    await expect(
      page.getByText(width > 600 ? "Re-checking, keeps its place" : "Closeout re-check").first(),
    ).toBeVisible();
    await page.screenshot({ path: join(directory, `merge-queue-${width}.png`), fullPage: true });
    await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-101`);
    await expect(
      page.getByText("Re-checking, keeps its place.", { exact: false }).first(),
    ).toBeVisible();
    await page.screenshot({ path: join(directory, `issue-${width}.png`), fullPage: true });
    await page.close();
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
  await server.stop(true);
}
