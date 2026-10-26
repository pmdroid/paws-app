import { statusFixture } from "../src/web/test/fixtures";
// Settings → Agents with a Claude catalog that offers a 1M context entry.
// Usage: bun run build:status && bun --no-env-file scripts/verify-agent-models-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const snapshot = statusFixture();
snapshot.source = "live";
const high = [{ id: "high", name: "High" }];
const catalogs = [
  {
    agent: "claude",
    updatedAt: 1,
    efforts: high,
    models: [
      { id: "opus", name: "Opus 5.5", longContext: false, efforts: high },
      { id: "opus[1m]", name: "Opus 5.5 · 1M context", longContext: true, efforts: high },
      { id: "sonnet", name: "Sonnet 5.5", longContext: false, efforts: high },
    ],
  },
  {
    agent: "codex",
    updatedAt: 1,
    efforts: high,
    models: [{ id: "gpt-5.5", name: "GPT-5.5", longContext: false, efforts: high }],
  },
];
const settings = {
  defaults: {
    implementer: { agent: "claude", model: "opus[1m]", effort: "high" },
    reviewer: { agent: "codex", model: "gpt-5.5", effort: "high" },
  },
  projects: [],
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/settings/agents") return Response.json(settings);
    if (path === "/api/runners/models") return Response.json({ catalogs });
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
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/settings/agents`);
    const model = page.locator("#defaults-implementer-model");
    const hint = page.getByText("1M context uses more of your Claude usage.");
    await expect(model).toBeEnabled();
    await expect(model).toHaveValue("opus[1m]");
    await expect(model.locator("option:checked")).toHaveText("Opus 5.5 · 1M context");
    await expect(model.locator('option[value="opus"]')).toHaveText("Opus 5.5");
    await expect(hint).toHaveCount(1);
    await expect(hint).toBeVisible();
    await expect(model).toHaveAttribute("aria-describedby", "defaults-implementer-model-hint");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.locator("#defaults-implementer-model").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, `agents-1m-${width}.png`), fullPage: true });
    await model.selectOption("opus");
    await expect(hint).toHaveCount(0);
    await model.selectOption("opus[1m]");
    await expect(hint).toHaveCount(1);
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Settings → Agents 1M context checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
