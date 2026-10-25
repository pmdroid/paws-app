// Real Settings save against disposable SQLite and profile snapshots. No external services.
// bun run build:status && bun scripts/verify-waiting-agent-settings-ui.ts <proof directory>
import { chromium, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/acp";
import { writeAgentSettings } from "../src/config";
import { systemClock } from "../src/core";
import {
  openDatabase,
  migrate,
  JobLoop,
  OutboxDispatcher,
  insertQueuedItem,
  beginImplementRun,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { handleAgentSettingsRequest, handleHookSettingsRequest } from "../src/settings";
import { demoStatus, handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a proof directory");
mkdirSync(directory, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "paws-waiting-settings-"));
const db = openDatabase(join(root, "paws.sqlite"));
migrate(db);
const orchestrator = new Orchestrator({
  db,
  pawsRoot: root,
  jobs: new JobLoop(db, systemClock),
  outbox: new OutboxDispatcher(db, systemClock),
});
const configPath = join(root, "config.toml");
const original = {
  implementer: { agent: "claude", model: "old" },
  reviewer: { agent: "codex", model: "review" },
} as const;
const files: string[] = [];
for (let index = 0; index < 3; index++) {
  const item = insertQueuedItem(db, { id: `waiting-${index}` });
  const { run } = beginImplementRun(db, item.id, Date.now());
  db.run("UPDATE work_item SET state='awaiting_input' WHERE id=?", [item.id]);
  mkdirSync(runDir(root, run.id), { recursive: true });
  const file = join(runDir(root, run.id), "agent-profile.json");
  writeFileSync(file, JSON.stringify({ profiles: original }));
  files.push(file);
}
const snapshot = demoStatus();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/settings/skills")
      return Response.json({
        skills: [],
        rollouts: [],
        agents: ["claude", "codex", "grok"],
        limitBytes: 20000000,
      });
    if (path === "/api/settings/hooks")
      return handleHookSettingsRequest(request, { db, csrfToken: "fixture", audit: () => {} });
    if (path === "/api/runners/models") return Response.json({ catalogs: [] });
    return (
      (await handleAgentSettingsRequest(request, {
        configPath,
        csrfToken: "fixture",
        applyToWaiting: () => orchestrator.applyAgentSettingsToWaiting(),
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
try {
  for (const width of [1440, 390]) {
    for (const file of files) writeFileSync(file, JSON.stringify({ profiles: original }));
    writeAgentSettings(configPath, { defaults: original, projects: [] });
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/status/settings/agents`);
    const toggle = page.getByRole("checkbox", { name: "Also switch runs that are waiting" });
    await expect(toggle).not.toBeChecked();
    await page.locator('[name="defaults-implementer-agent"]').selectOption("grok");
    await toggle.check();
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: join(directory, `agents-waiting-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Saved. 3 waiting runs will switch at their next step." }),
    ).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    for (const file of files)
      expect(JSON.parse(readFileSync(file, "utf8")).profiles.implementer.agent).toBe("grok");
    await page.screenshot({ path: join(directory, `agents-saved-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.close();
  }
  expect(errors).toEqual([]);
  writeFileSync(
    join(directory, "observations.json"),
    JSON.stringify(
      {
        widths: [1440, 390],
        uncheckedByDefault: true,
        realWaitingSnapshots: 3,
        saveCount: 3,
        resetAfterSave: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.stop(true);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
