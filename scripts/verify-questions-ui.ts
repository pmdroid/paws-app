import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { questionReaders, statusFixture } from "../src/dashboard/test/fixtures";
import { handleStatusRequest } from "../src/dashboard";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
const readers = questionReaders(snapshot);
const requests: string[] = [];
const held = new Map<string, Promise<void>>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/session") return new Response(null, { status: 404 });
    if (/^\/api\/(status|issues|questions)/.test(url.pathname)) requests.push(url.pathname);
    await held.get(url.pathname);
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot, ...readers },
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
const base = `http://127.0.0.1:${server.port}/dashboard`;
const errors: string[] = [];
const observations: Record<string, unknown> = {};

async function visit(page: Page, path: string): Promise<string[]> {
  requests.length = 0;
  await page.goto(`${base}${path}`);
  await page.waitForTimeout(800);
  return [...requests];
}

async function follow(page: Page, path: string): Promise<void> {
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    document.querySelector("#page-content")!.append(link);
    link.click();
  }, `${base}${path}`);
}

try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });

    const list = await visit(page, "/questions");
    await expect(page.locator("#q-Q-41")).toBeVisible();
    await expect(page.locator("#q-Q-40")).toBeVisible();
    await expect(page.locator('#q-Q-41 a[href="/dashboard/issues/ENG-103"]')).toBeVisible();
    expect(list).toEqual(["/api/questions"]);
    requests.length = 0;
    await page.waitForTimeout(5_500);
    expect(new Set(requests)).toEqual(new Set(["/api/questions"]));
    await page.screenshot({ path: join(directory, `questions-${width}.png`), fullPage: true });

    const selected = await visit(page, "/questions/Q-41");
    await expect(page.locator("#q-Q-41")).toHaveClass(/\bhl\b/);
    await expect(page.locator("#q-Q-40")).toHaveCount(0);
    expect(selected).toEqual(["/api/questions/Q-41"]);
    requests.length = 0;
    await page.waitForTimeout(5_500);
    expect(new Set(requests)).toEqual(new Set(["/api/questions/Q-41"]));
    await page.screenshot({ path: join(directory, `question-${width}.png`), fullPage: true });

    let release = () => {};
    held.set("/api/questions/Q-40", new Promise<void>((resolve) => (release = resolve)));
    await follow(page, "/questions/Q-40");
    await page.waitForTimeout(300);
    await follow(page, "/questions/Q-41");
    await expect(page.locator("#q-Q-41")).toBeVisible();
    release();
    held.clear();
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/questions\/Q-41$/);
    await expect(page.locator("#q-Q-41")).toBeVisible();
    await expect(page.locator("#q-Q-40")).toHaveCount(0);

    await visit(page, "/questions/Q-404");
    await expect(
      page.getByText("This question is answered, or it is not in your sessions."),
    ).toBeVisible();
    await page.screenshot({
      path: join(directory, `question-missing-${width}.png`),
      fullPage: true,
    });
    observations[`width-${width}`] = { list, selected, lateResponseIgnored: true };
    await page.close();
  }
  expect(errors).toEqual([]);
  writeFileSync(join(directory, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
  console.log(`Questions page verified. Screenshots in ${directory}`);
} finally {
  await browser.close();
  await server.stop(true);
}
