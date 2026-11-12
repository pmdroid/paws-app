import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentSettingsRequest, handleCheckoutSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/dashboard";
import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const configPath = join(mkdtempSync(join(tmpdir(), "paws-checkout-")), "config.toml");
const snapshot = fullStatusFixture();
snapshot.source = "live";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "user-1",
        role: "admin",
        user: { name: "Ada Admin", email: "ada@example.com" },
        workspaceId: "ws-1",
        csrfToken: "ui-fixture",
        workspaces: [{ id: "ws-1", name: "Acme", role: "admin" }],
      });
    if (path === "/api/settings/skills")
      return Response.json({
        skills: [],
        rollouts: [],
        agents: ["claude", "codex"],
        limitBytes: 1,
      });
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    return (
      (await handleCheckoutSettingsRequest(request, {
        configPath,
        csrfToken: "ui-fixture",
        repos: ["acme/platform", "acme/web"],
      })) ??
      (await handleAgentSettingsRequest(request, { configPath, csrfToken: "ui-fixture" })) ??
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
        csrfToken: "ui-fixture",
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
const checkout = async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/settings/checkout`);
  const data = (await response.json()) as {
    repositories: { repo: string; paths: { path: string }[] }[];
  };
  return data.repositories
    .find((repository) => repository.repo === "acme/platform")
    ?.paths.map((entry) => entry.path);
};
try {
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      writeFileSync(
        configPath,
        `[checkout.projects."acme/platform"]\nexclude = ["docs/archive"]\n`,
      );
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });

      await page.goto(`http://127.0.0.1:${server.port}/dashboard/settings/agents`);
      await expect(page.locator("#agent-settings")).not.toBeEmpty();
      await expect(page.getByRole("heading", { name: "Repository checkout" })).toHaveCount(0);
      await page.screenshot({
        path: join(directory, `agents-${width}-${scheme}.png`),
        fullPage: true,
      });

      await page.goto(`http://127.0.0.1:${server.port}/dashboard/settings/workspace`);
      await expect(
        page.getByText("Manage repository access and what agents see of each repository."),
      ).toBeVisible();
      const section = page.locator("#checkout-settings");
      await expect(section.getByRole("heading", { name: "Repository checkout" })).toBeVisible();
      await expect(section.getByText("docs/archive", { exact: true })).toBeVisible();
      const headings = await page
        .locator('#workspace-access [data-settings-page="workspace"]:not([hidden]) h2')
        .allTextContents();
      expect(headings).toEqual(["Members", "Repositories", "Repository checkout"]);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: join(directory, `workspace-${width}-${scheme}.png`),
        fullPage: true,
      });

      await section.getByLabel("Add a path or glob").first().fill("packages/archived/");
      await section.getByRole("button", { name: "Add path" }).first().click();
      await section.getByRole("button", { name: "Save", exact: true }).click();
      await expect(section.getByText("Saved.")).toBeVisible();
      expect(await checkout()).toEqual(["docs/archive", "packages/archived/"]);

      await section.getByRole("button", { name: "Remove docs/archive" }).click();
      await section.getByRole("button", { name: "Save", exact: true }).click();
      await expect(section.getByText("Saved.")).toBeVisible();
      expect(await checkout()).toEqual(["packages/archived/"]);
      await page.close();
    }
  }
  expect(errors).toEqual([]);
  console.log(`Repository checkout checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
