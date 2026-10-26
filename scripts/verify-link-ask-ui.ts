import { statusFixture } from "../src/web/test/fixtures";
// The overview's Needs you list with the four kinds of link asks, and the bypass card on the
// issue page, against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-link-ask-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const template = snapshot.items.find((item) => item.id === "ENG-103")!;
const question = snapshot.questions[0]!;
const add = (id: string, title: string) =>
  snapshot.items.push({ ...template, id, title, runId: null, links: [] });
add("ENG-105", "Audit settings page");
add("ENG-106", "Session token rotation");
const linkAsk = (
  id: string,
  itemId: string,
  kind: "bypass" | "screenshots" | "risk" | "question",
  head: string,
  title: string,
  detail: string,
  anchor: string,
) => ({
  ...question,
  id,
  itemId,
  runId: null,
  title,
  body: detail,
  context: "",
  options: [],
  recommendedOption: null,
  linkAsk: {
    kind,
    head,
    title,
    detail,
    link: `https://paws.example/status/issues/${itemId}#${anchor}`,
  },
});
snapshot.questions = [
  linkAsk(
    "Q-50",
    "ENG-103",
    "bypass",
    "7f65200aa1",
    "Closeout needs your decision on 7f65200.",
    "independent-review failed (P1, docs/smoke-test.md). 7 other checks passed.",
    "closeout",
  ),
  linkAsk(
    "Q-51",
    "ENG-105",
    "screenshots",
    "4b317d5bb2",
    "The screens of 4b317d5 need your visual review.",
    "3 changed screens wait for your visual review of 4b317d5.",
    "visual-review",
  ),
  linkAsk(
    "Q-52",
    "ENG-106",
    "risk",
    "c0ffee1cc3",
    "High-risk changes in c0ffee1 need your approval.",
    "High-risk paths changed: src/auth/session.ts. Approve before merge.",
    "risk",
  ),
  linkAsk(
    "Q-53",
    "ENG-100",
    "question",
    "9a8b7c6dd4",
    "Paws needs your answer on 9a8b7c6.",
    "How long should export download links stay valid?",
    "question",
  ),
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
      for (const name of ["Review bypass", "Review screenshots", "Review risk", "Answer question"])
        await expect(page.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(directory, `needs-you-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("link", { name: /^Review bypass/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-103#closeout$/);
      const card = page.locator("#closeout");
      await expect(card.getByRole("heading", { name: "Closeout bypass" })).toBeVisible();
      await expect(card.getByRole("button", { name: "Bypass" })).toBeVisible();
      await expect(card.getByRole("button", { name: "Send guidance" })).toBeVisible();
      await card.screenshot({ path: join(directory, `bypass-card-${scheme}-${width}.png`) });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Link ask checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
