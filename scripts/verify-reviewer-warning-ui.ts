import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentSettings } from "../src/config";
import { handleAgentSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/dashboard";
import { statusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a proof directory");
mkdirSync(directory, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "paws-reviewer-warning-"));
const configPath = join(root, "config.toml");
const snapshot = statusFixture();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    if (["/api/settings/checkout", "/api/settings/skills", "/api/settings/hooks"].includes(path))
      return Response.json({ error: "Not part of this proof" }, { status: 403 });
    return (
      (await handleAgentSettingsRequest(request, {
        configPath,
        csrfToken: "fixture",
        runnerReadiness: (agent) =>
          agent === "claude"
            ? [{ name: "studio", ready: true }]
            : [
                { name: "laptop", ready: false },
                { name: "studio", ready: false },
              ],
      })) ??
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "fixture",
      })) ??
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
const refusals: string[] = [];
try {
  for (const width of [1440, 390]) {
    writeAgentSettings(configPath, {
      defaults: {
        implementer: { agent: "claude", model: null },
        reviewer: { agent: "claude", model: "opus" },
      },
      projects: [],
    });
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/dashboard/settings/agents`);
    await page.locator('[name="defaults-reviewer-agent"]').selectOption("codex");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    const warning = page.getByRole("alert").filter({
      hasText: "No active runner has codex signed in and ready to review: laptop, studio.",
    });
    await expect(warning).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Agent settings saved" }),
    ).toBeVisible();
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: join(directory, `reviewer-warning-${width}.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const refused = await page.evaluate(async () => {
      const response = await fetch("/api/settings/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-paws-csrf": "fixture" },
        body: JSON.stringify({
          defaults: {
            implementer: { agent: "codex", model: "gpt" },
            reviewer: { agent: "codex", model: "gpt" },
          },
          projects: [],
        }),
      });
      return `${response.status} ${((await response.json()) as { error: string }).error}`;
    });
    refusals.push(refused);
    await page.close();
  }
  expect(errors).toEqual([]);
  expect(refusals).toEqual([
    "400 Implementer and reviewer must use different agents or different models",
    "400 Implementer and reviewer must use different agents or different models",
  ]);
  writeFileSync(
    join(directory, "observations.json"),
    JSON.stringify({ widths: [1440, 390], warningShown: true, refusals, errors }, null, 2),
  );
} finally {
  await browser.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
