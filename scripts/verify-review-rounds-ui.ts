import { statusFixture } from "../src/web/test/fixtures";
// The overview's Needs you list with a review-rounds ask, and its card on the issue page,
// against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-review-rounds-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const question = snapshot.questions[0]!;
const title = "Review rounds ran out on 4b317d5.";
const detail =
  'The independent review failed 4 rounds and 3 findings are still open. The class of bug that keeps coming back is "unchecked null" (2 of 3 open findings). Rethink the approach, keep going, or stop.';
snapshot.questions = [
  {
    ...question,
    id: "Q-60",
    itemId: "ENG-103",
    runId: null,
    title,
    body: detail,
    context: "",
    options: [],
    recommendedOption: null,
    linkAsk: {
      kind: "rounds",
      head: "4b317d5bb2",
      title,
      detail,
      link: "https://paws.example/status/issues/ENG-103#review-rounds",
      rounds: {
        rounds: [
          { head: "7f65200aa1", findings: 5 },
          { head: "1c2d3e4ff0", findings: 4 },
          { head: "9a8b7c6dd4", findings: 3 },
          { head: "4b317d5bb2", findings: 3 },
        ],
        open: [
          { severity: "P1", location: "src/delivery/signed-url.ts:42", bugClass: "unchecked null" },
          { severity: "P1", location: "src/delivery/signed-url.ts:88", bugClass: "unchecked null" },
          { severity: "P2", location: "src/delivery/cache.ts:17", bugClass: "missing await" },
        ],
        bugClass: "unchecked null",
        limit: 4,
      },
    },
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
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.port}/status/`);
      await expect(page.getByRole("link", { name: /^Answer question/ })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(directory, `rounds-needs-you-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("link", { name: /^Answer question/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-103#review-rounds$/);
      const card = page.locator("#review-rounds");
      await expect(card.getByRole("heading", { name: "Review rounds" })).toBeVisible();
      for (const name of ["Rethink the approach", "Keep going", "Stop"])
        await expect(card.getByRole("button", { name })).toBeVisible();
      await expect(card.getByText("Round 4:")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(directory, `rounds-card-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Review rounds checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
