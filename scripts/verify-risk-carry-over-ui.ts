import { fixtureProvider, fullStatusFixture } from "../src/web/test/fixtures";
// The Risk card on the issue page after a person approved a high-risk head: a fix that changed
// no high-risk path keeps the approval, and a fix that changed one asks again with only its own
// high-risk paths since the approved head. Against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-risk-carry-over-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = fullStatusFixture();
snapshot.source = "live";
const template = snapshot.items.find((item) => item.id === "ENG-103")!;
const question = snapshot.questions[0]!;
snapshot.items.push(
  {
    ...template,
    id: "ENG-106",
    title: "Session token rotation",
    runId: null,
    links: [],
    riskCarryOver: {
      head: "9c1d2e3ff0",
      approvedHead: "c0ffee1cc3",
      changed: ["test/session.test.ts"],
      reason:
        "The approval of c0ffee1 carried over: none of the files the fix changed since then is a high-risk path (`test/session.test.ts`).",
    },
  },
  { ...template, id: "ENG-107", title: "Session cookie flags", runId: null, links: [] },
);
const title = "High-risk changes in 5eed5a1 need your approval.";
const detail = "High-risk paths the fix changed since the approved c0ffee1: `src/auth/session.ts`.";
snapshot.questions = [
  {
    ...question,
    id: "Q-60",
    itemId: "ENG-107",
    runId: null,
    title,
    body: detail,
    context: "",
    options: [],
    recommendedOption: null,
    linkAsk: {
      kind: "risk",
      head: "5eed5a1dd4",
      title,
      detail,
      link: "https://paws.example/status/issues/ENG-107#risk",
      risk: {
        paths: ["src/auth/session.ts"],
        since: "c0ffee1cc3",
        summary: "Closeout accepted 5eed5a1: 9 checks passed.",
        findings: [],
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
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      const fits = () =>
        expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);

      await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-106#risk`);
      const carried = page.locator("#risk");
      await expect(carried.getByRole("heading", { name: "Risk", exact: true })).toBeVisible();
      await expect(carried.getByText("Approved", { exact: true })).toBeVisible();
      await expect(carried).toContainText(
        "The approval of c0ffee1 carried over to 9c1d2e3: none of the files the fix changed since then is a high-risk path.",
      );
      await expect(carried.getByText("test/session.test.ts", { exact: true })).toBeVisible();
      await fits();
      await carried.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(directory, `risk-carried-over-${scheme}-${width}.png`) });

      await page.goto(`http://127.0.0.1:${server.port}/status/`);
      await page.getByRole("link", { name: /^Review risk/ }).click();
      await expect(page).toHaveURL(/\/status\/issues\/ENG-107#risk$/);
      const asked = page.locator("#risk");
      await expect(asked).toContainText(
        "High-risk paths the fix changed since the approved c0ffee1:",
      );
      await expect(asked.locator(".risk-paths li")).toHaveText(["src/auth/session.ts"]);
      await expect(asked.getByRole("button", { name: "Approve 5eed5a1" })).toBeEnabled();
      await expect(asked).toContainText("A later fix keeps it when it changes no high-risk path");
      await fits();
      await asked.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(directory, `risk-ask-again-${scheme}-${width}.png`) });
      await page.close();
    }
  expect(errors).toEqual([]);
  console.log(`Risk carry-over checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
