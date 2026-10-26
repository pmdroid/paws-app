import { statusFixture } from "../src/web/test/fixtures";
// Settings → Merging against the real settings handler and a temporary config.toml, and a run
// page whose pull request waits in the GitHub merge queue.
// Usage: bun run build:status && bun --no-env-file scripts/verify-merge-settings-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, readMergeSettings } from "../src/config";
import { handleMergeSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const PAWS = "843abf82-7a05-4340-b47b-2c81fe6e6e16";
const MONOREPO = "0b5c1d2e-3f40-4a51-8b62-7c83d94e05f6";
const PAYMENTS = "4179d503-3ec3-4be7-a8ef-4415a2d9b5e9";
const snapshot = statusFixture();
snapshot.source = "live";
const queuedRun = snapshot.runs.find((run) => run.id === "r-102")!;
const queuedItem = snapshot.items.find((item) => item.id === queuedRun.itemId)!;
queuedItem.state = "merge_queue";
queuedItem.githubQueue = {
  position: 2,
  state: "AWAITING_CHECKS",
  line: "Second in the acme/platform GitHub merge queue, waiting for checks.",
};
const audits: string[] = [];
/** Configured repositories whose main has a GitHub merge queue. */
let githubQueues = ["acme/platform"];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
    return (
      (await handleMergeSettingsRequest(request, {
        configPath,
        csrfToken: "ui-fixture",
        audit: (_action, subject) => audits.push(subject),
        upToDateRules: async () => ["acme/platform"],
        choices: async () => ({
          projects: [
            { id: MONOREPO, name: "Monorepo" },
            { id: PAWS, name: "Paws" },
            { id: PAYMENTS, name: "Payments" },
          ],
          labels: ["Bug", "Chore", "Feature"],
        }),
        githubQueues: async () => githubQueues,
      })) ??
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "ui-fixture",
      })) ??
      new Response(null, { status: 404 })
    );
  },
});
const configPath = join(mkdtempSync(join(tmpdir(), "paws-merging-")), "config.toml");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors: string[] = [];
try {
  for (const width of [1440, 390]) {
    githubQueues = ["acme/platform"];
    writeFileSync(
      configPath,
      `[merge]\norder = "queue"\nmain_moved = "overlap"\n\n[merge.projects."${PAWS}"]\n\n[merge.projects."${MONOREPO}"]\norder = "github-queue"\nmain_moved = "overlap"\n\n[merge.repositories."acme/platform"]\npackages = ["apps/*", "packages/*"]\n`,
    );
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/settings/merging`);
    await expect(page.getByRole("heading", { name: "Workspace default" })).toBeVisible();
    await expect(page.locator("#project-0-main")).toBeDisabled();
    await expect(page.locator("#project-1-order")).toHaveValue("github-queue");
    await expect(page.locator("#project-1-order-help")).toHaveText(
      "GitHub's merge queue on acme/platform. A repository without one merges each pull request when its CI is green.",
    );
    await expect(page.locator('#default-order option[value="github-queue"]')).toHaveCount(1);
    await expect(page.locator("#default-main-help")).toHaveText(
      "GitHub requires branches to be up to date in acme/platform, so merges there always update the branch and wait for CI. Turn that rule off to merge without an update.",
    );

    // Payments: run Closeout again after a branch update.
    await page.locator("#merge-new-project").selectOption(PAYMENTS);
    await page.getByRole("button", { name: "Add project" }).click();
    await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible();
    await page.locator('[name="project-2-inherit"]').uncheck();
    await page.locator("#project-2-main").selectOption("closeout");
    // An issue rule for Paws bugs.
    await page.locator("#merge-rule-project").selectOption(PAWS);
    await page.locator("#merge-rule-label").selectOption("Bug");
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByRole("heading", { name: "Paws · label Bug" })).toBeVisible();
    await page.locator('[name="rule-0-inherit"]').uncheck();
    await page.locator("#rule-0-main").selectOption("closeout");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Merging settings saved.")).toBeVisible();

    const saved = readMergeSettings(loadConfigFile(configPath));
    expect(saved.projects[PAYMENTS]).toEqual({ order: "queue", mainMoved: "closeout" });
    expect(saved.rules).toEqual([
      { project: PAWS, label: "Bug", order: "queue", mainMoved: "closeout" },
    ]);
    expect(readFileSync(configPath, "utf8")).toContain("[[merge.rules]]");
    expect(saved.repositories).toEqual({
      "acme/platform": { packages: ["apps/*", "packages/*"] },
    });
    await expect(page.locator("#default-main-help")).toContainText("acme/platform");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(directory, `merging-${width}.png`), fullPage: true });

    // Without a merge queue in any repository, only a level that already uses it keeps the choice.
    githubQueues = [];
    await page.reload();
    await expect(page.getByRole("heading", { name: "Workspace default" })).toBeVisible();
    await expect(page.locator('#default-order option[value="github-queue"]')).toHaveCount(0);
    await expect(page.locator('#project-2-order option[value="github-queue"]')).toHaveCount(0);
    await expect(page.locator("#project-1-order-help")).toContainText(
      "No configured repository has a GitHub merge queue",
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: join(directory, `merging-no-github-queue-${width}.png`),
      fullPage: true,
    });

    await page.goto(`http://127.0.0.1:${server.port}/status/runs/r-102`);
    await expect(
      page.getByRole("heading", {
        name: "Second in the acme/platform GitHub merge queue, waiting for checks.",
      }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(directory, `run-github-queue-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }
  expect(errors).toEqual([]);
  expect(audits).toContain(`Rule label Bug in project ${PAWS} added`);
  console.log(`Settings → Merging checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
