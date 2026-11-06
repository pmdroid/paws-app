import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { listWorkspaceRepositoryNames, saveRetroSettingsRevision } from "../src/db";
import type { AgentModelCatalog } from "../src/runner-models";
import {
  createFakeRetroCatalog,
  createRetroPreviewHttp,
  createRetroReviewHttp,
  createRetroSettingsHttp,
  proposedRetroSettings,
  readRetroSettings,
} from "../src/retros";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { A, B, END, seedDaily, world } from "../test/improvement-fixtures";

const out =
  process.argv[2] ?? join(process.env.TMPDIR ?? "/tmp", `paws-retro-settings-ui-${Date.now()}`);
mkdirSync(out, { recursive: true });

const CATALOGS: AgentModelCatalog[] = [
  {
    agent: "codex",
    updatedAt: 1,
    efforts: [{ id: "medium", name: "Medium" }],
    defaultModel: "gpt-6-astra",
    models: [
      {
        id: "gpt-6-astra",
        name: "gpt-6-astra",
        longContext: false,
        efforts: [
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
        defaultEffort: "medium",
      },
      {
        id: "gpt-6-mini",
        name: "gpt-6-mini",
        longContext: false,
        efforts: [{ id: "low", name: "Low" }],
        defaultEffort: "low",
      },
    ],
  },
  {
    agent: "claude",
    updatedAt: 1,
    efforts: [],
    defaultModel: "opus",
    models: [{ id: "opus", name: "Opus", longContext: false, efforts: [], defaultEffort: null }],
  },
];

const w = world();
seedDaily(w.db);
saveRetroSettingsRevision(w.db, {
  ...proposedRetroSettings([A, B]),
  workspaceId: "ws",
  createdBy: "user-admin",
  now: END,
});
w.db.run(
  "UPDATE workspace_member SET source = 'manual', manual_role = 'admin' WHERE user_id = 'user-admin'",
);
const catalog = createFakeRetroCatalog(CATALOGS);
const settings = createRetroSettingsHttp({ db: w.db, catalog: catalog.read });
const preview = createRetroPreviewHttp({ db: w.db, artifactRoot: w.root });
const reviews = createRetroReviewHttp({ db: w.db, artifactRoot: w.root });
const schedule = () => {
  const view = readRetroSettings(w.db, {
    workspaceId: "ws",
    accessibleRepositories: listWorkspaceRepositoryNames(w.db, "ws"),
  });
  const paused = view.settings.schedule.cadence === "paused";
  return {
    saved: view.saved,
    settingsRevision: view.revision,
    schedule: view.settings.schedule,
    state: "ready",
    reason: null,
    nextRun: paused ? null : { at: END + 7 * 86_400_000, due: false },
    retry: null,
    blocked: null,
    lastSuccess: null,
    current: null,
    canEdit: true,
    canRun: true,
  };
};

const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
const origin = `http://127.0.0.1:${port}`;
const access = createWorkspaceAccess({
  db: w.db,
  publicUrl: origin,
  clientId: "client",
  installedOrganization: { id: "org", name: "Kyku" },
  memberships: {
    installation: async () => ({ id: "org", name: "Kyku" }),
    member: async (organizationId, userId) => ({
      organizationId,
      userId,
      active: true,
      guest: false,
      admin: false,
      teamIds: userId.endsWith("admin") ? ["team-a", "team-b"] : ["team-a"],
    }),
  },
});
const server = startServer({
  port,
  hostname: "127.0.0.1",
  db: w.db,
  workspaceAccess: access,
  improvements: w.improvements,
  retros: async (request, principal, sessionIds) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/retros/schedule") return Response.json(schedule());
    return (
      (await settings(request, principal)) ??
      (await preview(request, principal, path === "/api/retros/preview" ? [] : sessionIds)) ??
      reviews(request, principal, sessionIds)
    );
  },
});
const cookieFor = (userId: string) =>
  `${WORKSPACE_COOKIE}=${issueWorkspaceSession(w.db, { workspaceId: "ws", userId, now: Date.now() }).token}`;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors: string[] = [];
const checked: { page: string; width: number; theme: string; smallest: number }[] = [];
let models: () => Response = () => Response.json({ catalogs: CATALOGS });

async function open(width: number, theme: "light" | "dark", user = "user-admin") {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.setExtraHTTPHeaders({ cookie: cookieFor(user) });
  await context.addInitScript((value) => localStorage.setItem("paws.appearance", value), theme);
  await context.route("**/api/runners/models", async (route) => {
    const answer = models();
    await route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: await answer.text(),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}

async function layout(page: Page, name: string, width: number, theme: string) {
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-retro-settings] button, [data-retro-settings] select, [data-retro-settings] input:not([type=checkbox]), [data-retro-settings] textarea",
      ),
    ].filter((element) => element.offsetParent !== null);
    const unlabeled = controls
      .filter((element) => !element.matches("button"))
      .filter(
        (element) =>
          !element.id || document.querySelector(`label[for="${CSS.escape(element.id)}"]`) === null,
      )
      .map((element) => element.getAttribute("name"));
    const sizes = controls.map((element) => ({
      label: (element.textContent ?? element.getAttribute("name") ?? "").trim().slice(0, 40),
      height: element.getBoundingClientRect().height,
    }));
    const rendered = document.querySelector<HTMLElement>("#retro-prompt-preview");
    return {
      overflow,
      sizes,
      unlabeled,
      previewFont: rendered ? parseFloat(getComputedStyle(rendered).fontSize) : null,
    };
  });
  expect([name, width, theme, result.overflow <= 0]).toEqual([name, width, theme, true]);
  expect([name, width, theme, result.unlabeled]).toEqual([name, width, theme, []]);
  const small = result.sizes.filter((size) => size.height < 44);
  expect([name, width, theme, small]).toEqual([name, width, theme, []]);
  if (result.previewFont !== null) expect(result.previewFont).toBeGreaterThanOrEqual(12);
  checked.push({
    page: name,
    width,
    theme,
    smallest: Math.min(...result.sizes.map((size) => size.height)),
  });
  await page.screenshot({ path: join(out, `${name}-${width}-${theme}.png`), fullPage: true });
}

async function settingsPage(page: Page) {
  await page.goto(`${origin}/dashboard/improvements/settings`);
  await expect(page.locator("#retro-settings-heading")).toBeVisible();
  await expect(page.locator("#retro-prompt")).toBeVisible();
}

const notice = (page: Page) => page.locator("[data-retro-notice]");

try {
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await open(width, theme);
      await settingsPage(page);
      await page.getByRole("button", { name: "Preview prompt" }).click();
      await expect(page.locator("#retro-prompt-preview")).toContainText("Find up to 5");
      await layout(page, "settings", width, theme);
      await page.context().close();
    }

  const desk = await open(1440, "light");
  await settingsPage(desk);
  await expect(desk.locator("#retro-agent")).toHaveValue("codex");
  await expect(desk.locator("#retro-max-items")).toHaveValue("5");
  await expect(desk.getByLabel(A)).toBeChecked();

  await desk.locator("#retro-model").selectOption("gpt-6-astra");
  await desk.locator("#retro-effort").selectOption("high");
  await desk.locator("#retro-model").selectOption("gpt-6-mini");
  await expect(desk.locator("#retro-effort")).toHaveValue("");
  await desk.locator("#retro-agent").selectOption("claude");
  await expect(desk.locator("#retro-model")).toHaveValue("");
  await expect(desk.locator("#retro-model").locator("option")).toHaveText([
    "Agent default",
    "Opus",
  ]);
  await desk.locator("#retro-agent").selectOption("codex");
  await desk.locator("#retro-model").selectOption("gpt-6-astra");

  const editor = desk.locator("#retro-prompt");
  await editor.fill("Look at  only.\n\n{{digest}}");
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(8, 8));
  await desk.keyboard.press("ArrowRight");
  await desk.keyboard.press("ArrowLeft");
  await desk.keyboard.press("Tab");
  await expect(desk.locator('[data-retro-variable="period"]')).toBeFocused();
  await desk.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Look at {{period}} only.\n\n{{digest}}");
  await editor.fill("Look at {{nope}}.\n\n{{digest}}");
  await expect(desk.locator("#retro-prompt-error")).toHaveText("Unknown variable: nope.");
  await editor.fill("No digest at all.");
  await expect(desk.locator("#retro-prompt-error")).toContainText("{{digest}} exactly once");
  await desk.getByRole("button", { name: "Restore default prompt" }).click();
  await expect(editor).toHaveValue(/Review the Paws agent sessions/);
  await expect(desk.locator("#retro-prompt-error")).toHaveText("");
  await editor.fill("Custom retro for {{period}}, up to {{max_items}}.\n\n{{digest}}");
  await desk.locator("#retro-max-items").fill("3");
  await desk.getByRole("button", { name: "Preview prompt" }).click();
  await expect(desk.locator("#retro-prompt-preview")).toContainText("Custom retro for");
  await expect(desk.locator("#retro-prompt-preview")).toContainText("up to 3.");
  await layout(desk, "edited-preview", 1440, "light");

  await desk.locator("#retro-active-minutes").fill("500");
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(desk.locator("#retro-active-minutes-error")).toHaveText(
    "The time limit is 1 to 120 minutes.",
  );
  await expect(editor).toHaveValue(/Custom retro for/);
  await desk.locator("#retro-active-minutes").fill("20");
  await desk.locator("#retro-retries").fill("2");

  await desk.locator("nav[aria-label='Improvement pages'] a", { hasText: "History" }).click();
  await expect(desk).toHaveURL(`${origin}/dashboard/improvements/history`);
  await desk.locator("nav[aria-label='Improvement pages'] a", { hasText: "Settings" }).click();
  await expect(editor).toHaveValue(/Custom retro for/);
  await expect(desk.locator("#retro-active-minutes")).toHaveValue("20");
  await expect(desk.locator('[data-retro-live="dirty"]')).toHaveText("Unsaved changes");

  await desk.route("**/api/retros/settings", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"error":"Disk full."}',
        })
      : route.fallback(),
  );
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(notice(desk)).toContainText("Disk full. Your draft is kept");
  await expect(editor).toHaveValue(/Custom retro for/);
  await desk.unroute("**/api/retros/settings");

  await settings(
    new Request(`${origin}/api/retros/settings`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 2,
        settings: {
          ...proposedRetroSettings([A, B]),
          outputLimits: { maxItems: 1, workedWell: 0 },
        },
      }),
    }),
    { workspaceId: "ws", userId: "user-admin", role: "admin", authenticatedAt: 1, teamIds: [] },
  );
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(notice(desk)).toContainText(
    "Someone saved retro settings after you started editing",
  );
  await expect(editor).toHaveValue(/Custom retro for/);
  await layout(desk, "conflict", 1440, "light");
  await desk.getByRole("button", { name: "Save over revision 3" }).click();
  await expect(notice(desk)).toContainText("Saved revision 4");

  await desk.reload();
  await expect(editor).toHaveValue(/Custom retro for/);
  await expect(desk.locator("#retro-max-items")).toHaveValue("3");
  await expect(desk.locator("#retro-retries")).toHaveValue("2");
  await expect(desk.locator("#retro-model")).toHaveValue("gpt-6-astra");
  await desk.locator("#retro-worked-well").fill("1");
  await desk.getByRole("button", { name: "Cancel changes" }).click();
  await expect(desk.locator("#retro-worked-well")).toHaveValue("3");

  await desk.locator("#retro-cadence").selectOption("paused");
  await expect(desk.locator("#retro-next-run")).toContainText("Automatic retros are paused");
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(notice(desk)).toContainText("Saved revision 5");
  await desk.reload();
  await expect(
    desk.locator("#settings-weekly + p, section[aria-labelledby=settings-weekly]"),
  ).toContainText("Weekly retros are paused");
  await desk.locator("#retro-cadence").selectOption("weekly");
  await desk.locator("#retro-weekday").selectOption("friday");
  await desk.locator("#retro-time").fill("10:30");
  await desk.locator("#retro-time-zone").selectOption("Europe/Berlin");
  await expect(desk.locator("#retro-next-run")).toHaveText("Every Friday, 10:30 Europe/Berlin.");
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(notice(desk)).toContainText("Every Friday, 10:30 Europe/Berlin.");

  models = () =>
    Response.json({ catalogs: [{ ...CATALOGS[0]!, models: [CATALOGS[0]!.models[1]!] }] });
  await desk.reload();
  await expect(desk.locator("#retro-model")).toHaveValue("gpt-6-astra");
  await expect(desk.locator("#retro-model-error")).toContainText(
    "No signed-in runner offers gpt-6-astra",
  );
  models = () => Response.json({ catalogs: CATALOGS });

  w.db.run("INSERT INTO workspace_repository VALUES ('ws', 'acme/c', 'team-a')");
  await desk.reload();
  await desk.locator('[name="retro-repository"][value="acme/c"]').click();
  await expect(desk.locator('[name="retro-repository"][value="acme/c"]')).toBeChecked();
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(notice(desk)).toContainText("Saved revision 7");
  w.db.run("DELETE FROM workspace_repository WHERE repository = 'acme/c'");
  await desk.reload();
  await expect(desk.locator("[data-retro-settings]")).toContainText(
    "Paws cannot access this repository",
  );
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(desk.locator("#retro-repositories-error")).toContainText(
    "Paws cannot access acme/c",
  );
  await layout(desk, "repository-denied", 1440, "light");
  await desk.locator('[name="retro-repository"][value="acme/c"]').click();
  await expect(desk.locator('[name="retro-repository"][value="acme/c"]')).toHaveCount(0);
  await desk.getByRole("button", { name: "Save settings" }).click();
  await expect(notice(desk)).toContainText("Saved revision 8");

  await desk.goto(`${origin}/dashboard/improvements/reports/r1`);
  const frozen = desk.locator("[data-retro-frozen-details]");
  await frozen.locator("summary").click();
  await expect(frozen).toContainText("Settings revision1");
  await expect(frozen).toContainText("Review {{period}}.");
  await expect(frozen).not.toContainText("Custom retro for");
  await layout(desk, "frozen-report", 1440, "light");
  await desk.context().close();

  const member = await open(390, "dark", "user-ada");
  await settingsPage(member);
  await expect(member.locator("[data-retro-settings]")).toContainText(
    "Only workspace admins can change retro settings",
  );
  await expect(member.locator("#retro-prompt")).toBeDisabled();
  await expect(member.getByRole("button", { name: "Save settings" })).toHaveCount(0);
  await layout(member, "member", 390, "dark");
  await member.context().close();

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ out, checked }, null, 2));
} finally {
  await browser.close();
  await server.stop(true);
}
