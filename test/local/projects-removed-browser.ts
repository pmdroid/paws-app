import { statusFixture } from "../../src/web/test/fixtures";
// Captures the dashboard navigation without a Projects entry, at desktop and 390 px, and checks
// that /status/projects answers 404, for visual proof.
// Usage: bun run build:status && bun --no-env-file test/local/projects-removed-browser.ts <evidence-directory>
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "projects-removed-evidence");
await mkdir(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "admin",
        csrfToken: "projects-removed-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "projects-removed-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});

const browser = await chromium.launch({ headless: true });
const observations: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/status/`);
    await page.getByText("Needs you").first().waitFor();
    let scope = page.locator("body");
    if (width < 768) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      scope = page.getByRole("dialog");
      await scope.waitFor({ state: "visible" });
      await page.waitForTimeout(500);
    }
    const nav = scope.getByRole("navigation", { name: "Main navigation" }).first();
    await nav.getByText("Issues").first().waitFor({ state: "visible" });
    const links = (await nav.getByRole("link").allInnerTexts()).map((text) => text.trim());
    const shot = join(directory, `navigation-without-projects-${width}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const removed = await page.request.get(`http://127.0.0.1:${server.port}/status/projects`);
    observations.push({ width, links, projectsStatus: removed.status(), errors, shot });
    if (links.some((text) => /projects/i.test(text))) throw new Error(`nav still has Projects`);
    if (removed.status() !== 404) throw new Error(`/status/projects answered ${removed.status()}`);
    if (errors.length) throw new Error(errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
  await writeFile(join(directory, "observations.json"), JSON.stringify(observations, null, 2));
}
