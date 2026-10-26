import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { emptyLiveSnapshot, handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "/tmp/paws-single-source-proof");
await mkdir(directory, { recursive: true });
let unavailable = false;
let reads = 0;
const snapshot = emptyLiveSnapshot();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/status") {
      reads++;
      if (unavailable) return Response.json({ error: "Paws unavailable" }, { status: 503 });
    }
    return (
      (await handleStatusRequest(request, { provider: { snapshot: () => snapshot } })) ??
      new Response(null, { status: 404 })
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.addInitScript(() =>
      localStorage.setItem("paws.statusEngineUrl", "https://outside.invalid"),
    );
    for (const choice of ["demo", "https://outside.invalid"]) {
      const before = reads;
      await page.goto(`${origin}/status/?engine=${encodeURIComponent(choice)}`);
      await expect(page.locator("#content .empty")).toBeVisible();
      await expect.poll(() => reads).toBeGreaterThan(before);
      await expect(page.getByRole("dialog", { name: "Status source" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Engine", exact: true })).toHaveCount(0);
      expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
      expect(requests.some((url) => url.endsWith("config.json"))).toBe(false);
    }
    await expect
      .poll(() => page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
      .toBe(true);
    await page.screenshot({ path: join(directory, `status-live-${width}.png`), fullPage: true });
    unavailable = true;
    await page.reload();
    await expect(page.locator("#content")).toContainText("Status unavailable");
    await expect(page.locator("#content")).not.toContainText("Admin export UI");
    await page.screenshot({
      path: join(directory, `status-unavailable-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#content")).toContainText("Status unavailable");
    unavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#content .empty")).toBeVisible();
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log(`Single-source browser checks passed at 1440 and 390 px. Screenshots: ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
