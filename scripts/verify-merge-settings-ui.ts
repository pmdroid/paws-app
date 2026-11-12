import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";
// Settings → Merging against the real settings handler and a temporary config.toml, and a run
// page whose pull request waits in the GitHub merge queue.
// Usage: bun run build:dashboard && bun --no-env-file scripts/verify-merge-settings-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, readMergeSettings } from "../src/config";
import { handleMergeSettingsRequest } from "../src/settings";
import { handleStatusRequest } from "../src/dashboard";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const PAWS = "843abf82-7a05-4340-b47b-2c81fe6e6e16";
const snapshot = fullStatusFixture();
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
        repos: ["acme/platform"],
        githubQueues: async () => githubQueues,
      })) ??
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
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
      `[merge]\norder = "queue"\nmain_moved = "overlap"\n\n[merge.projects."${PAWS}"]\norder = "github-queue"\n\n[[merge.rules]]\nlabel = "Bug"\nmain_moved = "closeout"\n\n[merge.repositories."acme/platform"]\npackages = ["apps/*", "packages/*"]\n`,
    );
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/dashboard/settings/merging`);
    await expect(page.locator("#merge-settings-form h2").first()).toHaveText("Merging");
    for (const gone of ["Workspace default", "Projects", "Issue rules"])
      await expect(page.getByRole("heading", { name: gone, exact: true })).toHaveCount(0);
    await expect(page.locator('#default-order option[value="github-queue"]')).toHaveCount(1);
    await expect(page.locator("#default-main-help")).toHaveText(
      "GitHub requires branches to be up to date in acme/platform, so merges there always update the branch and wait for CI. Turn that rule off to merge without an update.",
    );

    await page.locator("#default-main").selectOption("closeout");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Merging settings saved.")).toBeVisible();

    const saved = readMergeSettings(loadConfigFile(configPath));
    expect(saved.default).toEqual({ order: "queue", mainMoved: "closeout" });
    expect(readFileSync(configPath, "utf8")).not.toContain("[[merge.rules]]");
    expect(saved.repositories).toEqual({
      "acme/platform": { packages: ["apps/*", "packages/*"] },
    });
    await expect(page.locator("#default-main-help")).toHaveText(
      "A Closeout re-check starts with a fresh retry budget.",
    );

    await expect(page.getByRole("heading", { name: "Ignored PR comments" })).toBeVisible();
    await expect(page.locator("#ignore-bots-0")).toHaveValue(/codecov\[bot\]/);
    await page.locator("#ignore-bots-0").fill("codecov[bot]\nnot a login");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#ignore-bots-0-error")).toContainText("must be a GitHub login");
    await expect(page.locator("#ignore-bots-0")).toHaveAttribute("aria-invalid", "true");
    await page.locator("#ignore-bots-0").fill("codecov[bot]\ndeploy-bot");
    await page
      .locator("#ignore-markers-0")
      .fill("<!-- add-pr-comment:todo-count -->\n<!-- deploy-security-proof -->");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Merging settings saved.")).toBeVisible();
    expect(readMergeSettings(loadConfigFile(configPath)).repositories["acme/platform"]).toEqual({
      packages: ["apps/*", "packages/*"],
      ignoreCommentBots: ["codecov[bot]", "deploy-bot"],
      ignoreCommentMarkers: [
        "<!-- add-pr-comment:todo-count -->",
        "<!-- deploy-security-proof -->",
      ],
    });
    await page.locator("#merge-ignored-comments").screenshot({
      path: join(directory, `merging-ignored-comments-${width}.png`),
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(directory, `merging-${width}.png`), fullPage: true });

    // Without a merge queue in any repository, only a level that already uses it keeps the choice.
    githubQueues = [];
    await page.reload();
    await expect(page.locator("#merge-settings-form h2").first()).toHaveText("Merging");
    await expect(page.locator('#default-order option[value="github-queue"]')).toHaveCount(0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: join(directory, `merging-no-github-queue-${width}.png`),
      fullPage: true,
    });

    await page.goto(`http://127.0.0.1:${server.port}/dashboard/runs/r-102`);
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
  expect(audits).toContain(
    "Workspace default when main moved: Update and re-test only when main changed the same files or package → Always update the branch and run Closeout again",
  );
  console.log(`Settings → Merging checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
