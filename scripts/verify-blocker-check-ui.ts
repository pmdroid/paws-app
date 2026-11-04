import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const snapshot = fullStatusFixture();
snapshot.source = "live";
const held = snapshot.items[0]!;
held.state = "queued";
held.blockers = [];
delete held.queue;
held.held = {
  reason: "blocked",
  blockers: ["ACME-12"],
  checkedAt: new Date(Date.parse(snapshot.generatedAt) - 2 * 60_000).toISOString(),
};
const provider = fixtureProvider(snapshot);
let presses = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/blocker-checks" && request.method === "POST") {
      presses++;
      return presses % 2
        ? Response.json({ itemId: held.id, changed: false, checkedAt: snapshot.generatedAt })
        : Response.json(
            { error: `Blockers for ${held.id} were just checked. Try again in 12 s.` },
            { status: 429, headers: { "retry-after": "12" } },
          );
    }
    return (
      (await handleStatusRequest(request, { provider, csrfToken: "ui-fixture" })) ??
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
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/dashboard/issues/${held.id}`);
    const check = page.locator("#blocker-check");
    await expect(page.getByText("Waiting: blocked by ACME-12").first()).toBeVisible();
    await expect(check).toContainText("Blockers last checked 2m ago");
    const button = check.getByRole("button", { name: "Check blockers now" });
    await expect(button).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: join(directory, `blocker-check-${width}.png`) });
    await button.click();
    await expect(check).toContainText("Blockers checked. Nothing changed in Linear.");
    await check.getByRole("button", { name: "Check blockers now" }).click();
    await expect(check).toContainText("were just checked. Try again in 12 s.");
    await check.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, `blocker-check-refused-${width}.png`) });
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Blocker check passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
