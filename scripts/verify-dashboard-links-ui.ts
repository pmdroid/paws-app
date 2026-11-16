import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";

const directory = await mkdtemp(join(tmpdir(), "paws-dashboard-links-"));
const evidence = process.env.PAWS_UI_EVIDENCE_DIR ?? directory;
const full = fullStatusFixture();
full.source = "live";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/session") return new Response(null, { status: 404 });
    if (url.pathname === "/api/settings/agents")
      return Response.json({
        defaults: {
          implementer: { agent: "claude", model: null },
          reviewer: { agent: "codex", model: null },
        },
      });
    if (url.pathname === "/api/runners")
      return Response.json({ setupRequired: true, workspaceReady: false, runners: [] });
    if (url.pathname === "/api/linear/sessions")
      return Response.json({ available: true, sessions: [] });
    if (url.pathname === "/api/execution-controls")
      return Response.json({ available: true, actions: [] });
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(full),
        csrfToken: "ui-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors: string[] = [];
const heading = (page: import("@playwright/test").Page) => page.locator("#content h1");
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${origin}/?engine=live`);
    await expect(page).toHaveURL(`${origin}/dashboard/?engine=live`);
    await expect(heading(page)).toHaveText("Overview");

    await page.goto(`${origin}/dashboard/issues/ENG-103?from=linear#closeout`);
    await expect(page).toHaveURL(`${origin}/dashboard/issues/ENG-103?from=linear#closeout`);
    await expect(page.locator("#content")).toContainText("ENG-103");
    await page.screenshot({ path: join(evidence, `issue-${width}.png`), fullPage: true });

    await page.goto(`${origin}/dashboard/settings/integrations`);
    await expect(page).toHaveURL(`${origin}/dashboard/workspace/integrations`);
    await expect(page.getByRole("region", { name: "Workspace settings" })).toContainText(
      "Configure workspace sign-in",
    );
    await page.reload();
    await expect(page).toHaveURL(`${origin}/dashboard/workspace/integrations`);
    await expect(page.getByRole("region", { name: "Workspace settings" })).toContainText(
      "Configure workspace sign-in",
    );

    await page.goto(`${origin}/dashboard/findings?status=all&severity=high#finding-1`);
    await expect(page).toHaveURL(`${origin}/dashboard/findings?status=all&severity=high#finding-1`);
    await expect(heading(page)).toHaveText("Findings");

    await page.goto(`${origin}/dashboard/sessions`);
    await expect(page).toHaveURL(`${origin}/dashboard/issues`);
    await expect(heading(page)).toHaveText("Issues");

    await page.goto(`${origin}/dashboard/settings/unknown`);
    await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeVisible();
    await page.goto(`${origin}/dashboard/not-a-page`);
    await expect(heading(page)).toHaveText("Overview");

    const removed = await page.goto(`${origin}/dashboard/projects`);
    expect(removed?.status()).toBe(404);
    expect(page.url()).toBe(`${origin}/dashboard/projects`);
    expect((await page.request.get(`${origin}/dashboard/assets/missing.js`)).status()).toBe(404);

    const transcript = await page.goto(`${origin}/dashboard/runs/r-102/transcript`);
    expect(transcript?.status()).toBe(200);
    expect(page.url()).toBe(`${origin}/dashboard/runs/r-102/transcript`);
    await expect(page).toHaveTitle("Transcript · r-102 · Paws");
    await page.screenshot({ path: join(evidence, `transcript-${width}.png`) });
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.log(`dashboard links verified; screenshots in ${evidence}`);
} finally {
  await browser.close();
  await server.stop(true);
  if (!process.env.PAWS_UI_EVIDENCE_DIR) await rm(directory, { recursive: true, force: true });
}
