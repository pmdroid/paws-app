import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { demoStatus, handleStatusRequest } from "../src/web";

const dist = join(import.meta.dir, "../src/web/dist/index.html");
// Needs `bun run build:status` and a Playwright Chromium; CI builds the dashboard after the tests.
const browsers = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? join(homedir(), ".cache/ms-playwright");
const ready =
  existsSync(dist) &&
  existsSync(browsers) &&
  readdirSync(browsers).some((entry) => entry.startsWith("chromium"));

test.skipIf(!ready)(
  "the paused run page fits 390 px and sends Resume now",
  async () => {
    const snapshot = demoStatus();
    snapshot.source = "live";
    const run = snapshot.runs.find((entry) => entry.id === "r-102")!;
    run.state = "paused";
    run.runner = "agentbox";
    run.pause = {
      reason: "usage_limit",
      agent: "Claude",
      phase: "implementation",
      resetsAt: new Date(Date.parse(snapshot.generatedAt) + 35 * 60_000).toISOString(),
      resumeAt: new Date(Date.parse(snapshot.generatedAt) + 36 * 60_000).toISOString(),
      runner: "agentbox",
    };
    const actions: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/session") return new Response(null, { status: 404 });
        if (path === "/api/execution-controls") {
          if (request.method === "POST") actions.push((await request.json()).action);
          return Response.json({ available: true, actions: ["stop", "resume_now"] });
        }
        return (
          (await handleStatusRequest(request, {
            provider: { snapshot: () => snapshot },
            csrfToken: "paused-fixture",
          })) ?? new Response(null, { status: 404 })
        );
      },
    });
    const browser = await chromium.launch({ headless: true });
    try {
      for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto(`http://127.0.0.1:${server.port}/status/runs/r-102`);
        const resume = page.getByRole("button", { name: "Resume now", exact: true });
        await resume.waitFor();
        expect(await page.locator(".run-heading .st").textContent()).toBe("Paused · usage limit");
        expect(await page.locator('.run-step[aria-current="step"]').textContent()).toContain(
          "Implementation · paused until",
        );
        expect(await page.locator(".pause-headline").textContent()).toContain(
          "Claude reached its usage limit. Paws continues at",
        );
        expect(await page.getByText("Stop", { exact: true }).isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (process.env.PAWS_UI_EVIDENCE_DIR)
          await page.screenshot({
            path: join(process.env.PAWS_UI_EVIDENCE_DIR, `run-paused-${width}.png`),
            fullPage: true,
          });
        await resume.click();
        for (let attempt = 0; attempt < 200 && !actions.length; attempt++) await Bun.sleep(10);
        expect(actions.splice(0)).toEqual(["resume_now"]);
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      await server.stop(true);
    }
  },
  60_000,
);
