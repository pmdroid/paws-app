import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { insertQueuedItem, listImprovementDeliveries } from "../src/db";
import {
  deliverImprovements,
  syncImprovementOutcomes,
  type StartIssueSession,
} from "../src/improvements";
import { createFakeImprovementLinear } from "../src/linear";
import { createRetroReviewHttp } from "../src/retros";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { END, seedDaily, world } from "../test/improvement-fixtures";

const out =
  process.argv[2] ?? join(process.env.TMPDIR ?? "/tmp", `paws-improvements-ui-${Date.now()}`);
mkdirSync(out, { recursive: true });

const MERGE = "c0ffee1234567890c0ffee1234567890c0ffee12";
const linear = createFakeImprovementLinear();
const starts: string[] = [];
const startSession: StartIssueSession = async (target) => {
  starts.push(target.id);
  return { id: `session-${starts.length}`, url: null };
};
const w = world({ linear, startSession, dashboardUrl: "http://127.0.0.1/" });
seedDaily(w.db);
const retro = w.retro.a;
const reviews = createRetroReviewHttp({ db: w.db, artifactRoot: w.root, now: w.now });
let scheduleState: "ready" | "waiting" | "generating" | "failed" = "ready";
const schedule = () => ({
  saved: true,
  settingsRevision: 1,
  schedule: { weekday: "monday", time: "09:00", timeZone: "UTC" },
  state: scheduleState,
  reason:
    scheduleState === "failed"
      ? "The runner disconnected before returning a complete result."
      : scheduleState === "ready"
        ? null
        : "Waiting for a compatible paired runner with a free slot.",
  nextRun: { at: END + 7 * 86_400_000, due: false },
  retry: null,
  blocked: null,
  lastSuccess: {
    retroId: "r1",
    cutoff: END,
    windowStart: END - 7 * 86_400_000,
    publishedAt: END,
    empty: false,
  },
  current:
    scheduleState === "ready"
      ? null
      : {
          retroId: "r1",
          origin: "manual",
          state: scheduleState,
          windowStart: END - 7 * 86_400_000,
          windowEnd: END,
          error: null,
          generation: {
            state: scheduleState === "waiting" ? "waiting_for_runner" : scheduleState,
            diagnostic: null,
            detail: null,
            attempt: 1,
            attemptsUsed: 1,
            maxAttempts: 2,
            retry: null,
            waitMs: 0,
            activeMs: 0,
            error: null,
          },
        },
  canEdit: false,
  canRun: true,
});

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
      teamIds: ["team-a"],
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
    if (path === "/api/retros/runs") {
      scheduleState = "waiting";
      return Response.json({ retroId: "r1", created: false, status: schedule() });
    }
    return reviews(request, principal, sessionIds);
  },
});
const cookieFor = (userId: string) =>
  `${WORKSPACE_COOKIE}=${issueWorkspaceSession(w.db, { workspaceId: "ws", userId, now: Date.now() }).token}`;
const ada = cookieFor("user-ada");

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors: string[] = [];
const requests: string[] = [];
const checked: { page: string; width: number; theme: string; smallest: number }[] = [];

async function open(width: number, theme: "light" | "dark", cookie = ada) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.setExtraHTTPHeaders({ cookie });
  await context.addInitScript((value) => localStorage.setItem("paws.appearance", value), theme);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  return page;
}

async function layout(page: Page, name: string, width: number, theme: string) {
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        "#improvements-page button, #improvements-page a.btn, #improvements-page select, #improvements-page input:not([type=checkbox]), #improvements-page a[data-improvement-row], nav[aria-label='Main navigation'] a",
      ),
    ].filter((element) => element.offsetParent !== null);
    const sizes = controls.map((element) => ({
      label: (element.textContent ?? element.getAttribute("name") ?? "").trim().slice(0, 40),
      height: element.getBoundingClientRect().height,
    }));
    return { overflow, sizes };
  });
  expect([name, width, theme, result.overflow <= 0]).toEqual([name, width, theme, true]);
  const small = result.sizes.filter((size) => size.height < 44);
  expect([name, width, theme, small]).toEqual([name, width, theme, []]);
  checked.push({
    page: name,
    width,
    theme,
    smallest: Math.min(...result.sizes.map((size) => size.height)),
  });
  await page.screenshot({ path: join(out, `${name}-${width}-${theme}.png`), fullPage: true });
}

async function visit(page: Page, path: string) {
  await page.goto(`${origin}${path}`);
  await expect(page.locator("#content h1").first()).toHaveText("Improvements");
}

try {
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      const page = await open(width, theme);
      await visit(page, "/dashboard/improvements");
      await expect(page.locator("[data-improvement-row]")).toHaveCount(2);
      await expect(page.locator("#improvements-page")).toContainText("Daily finding");
      await expect(page.locator("#improvements-page")).toContainText("Weekly retro");
      if (width > 800)
        await expect(
          page.locator("nav[aria-label='Main navigation'] a[href='/dashboard/improvements']"),
        ).toContainText("2");
      await layout(page, "inbox", width, theme);
      await visit(page, `/dashboard/improvements/${retro}`);
      await expect(page.locator("#improvement-heading")).toBeVisible();
      await layout(page, "item", width, theme);
      await visit(page, "/dashboard/improvements/reports/r1");
      await expect(page.locator("#improvements-page")).toContainText("of at most 5");
      await layout(page, "report", width, theme);
      await visit(page, "/dashboard/improvements/history");
      await layout(page, "history", width, theme);
      await visit(page, "/dashboard/improvements/settings");
      await layout(page, "settings", width, theme);
      await page.context().close();
    }

  const phone = await open(390, "light");
  await visit(phone, "/dashboard/improvements?source=weekly");
  await expect(phone.locator("[data-improvement-row]")).toHaveCount(1);
  await phone.locator("[data-improvement-row]").click();
  await expect(phone.locator("#improvement-heading")).toBeFocused();
  await expect(phone.locator(".improvement-list-pane")).toBeHidden();
  await phone.getByRole("link", { name: "All improvements" }).click();
  await expect(phone).toHaveURL(`${origin}/dashboard/improvements?source=weekly`);
  await expect(phone.locator(`[data-improvement-row="${retro}"]`)).toBeFocused();
  await phone.goBack();
  await expect(phone.locator("#improvement-heading")).toBeVisible();
  await phone.context().close();

  const desk = await open(1440, "dark");
  await desk.goto(`${origin}/dashboard/retros`);
  await expect(desk).toHaveURL(`${origin}/dashboard/improvements?source=weekly`);
  await desk.goto(`${origin}/status/improvements/reports/r1`);
  await expect(desk).toHaveURL(`${origin}/dashboard/improvements/reports/r1`);
  await desk.goto(`${origin}/dashboard/retros/r1`);
  await expect(desk).toHaveURL(`${origin}/dashboard/improvements/reports/r1`);

  await visit(desk, "/dashboard/improvements?source=weekly");
  await desk.locator(`[data-improvement-row="${retro}"]`).focus();
  await desk.keyboard.press("Enter");
  await expect(desk.locator("#improvement-heading")).toBeFocused();
  const other = await open(1440, "light", cookieFor("user-bea"));
  await other.goto(`${origin}/dashboard/improvements/${retro}`);
  await other.getByRole("button", { name: "Reject" }).click();
  await other.getByLabel("Why reject it?").fill("Covered by the recovery runbook");
  await other.locator('[data-improvement-form="reject"] button[type=submit]').click();
  await expect(other.locator("#improvements-page")).toContainText("Rejected by");
  await desk.locator('[data-improvement-form="create"] button[type=submit]').click();
  await expect(desk.locator("#improvements-page")).toContainText(
    "Someone changed this improvement after you opened it",
  );
  await expect(desk.locator("#improvements-page")).toContainText("Covered by the recovery runbook");
  await desk.getByRole("button", { name: "Reopen for review" }).click();
  await expect(desk.getByRole("button", { name: "File the issue" })).toBeVisible();
  await desk.locator('[data-improvement-form="create"] button[type=submit]').dblclick();
  await expect(desk.locator("#improvements-page")).toContainText("Accepted. Paws files the issue");
  expect(listImprovementDeliveries(w.db, retro)).toHaveLength(1);

  linear.fail("createIssue", "lose");
  const deliver = (at: number) =>
    deliverImprovements({
      db: w.db,
      owner: "verify",
      linearFor: async () => linear,
      sourceUrl: (id) => `${origin}/dashboard/improvements/${id}`,
      now: () => at,
    });
  await deliver(END + 60 * 60_000);
  await expect(desk.locator("#improvements-page")).toContainText("Checking with Linear", {
    timeout: 8_000,
  });
  await expect(other.locator("#improvements-page")).toContainText("Checking with Linear", {
    timeout: 12_000,
  });
  await layout(desk, "unknown-outcome", 1440, "dark");
  await deliver(END + 24 * 60 * 60_000);
  await expect(desk.getByRole("button", { name: "Delegate to Paws" })).toBeVisible({
    timeout: 8_000,
  });
  expect(linear.created).toHaveLength(1);
  expect(starts).toEqual([]);
  await layout(desk, "ready-to-delegate", 1440, "dark");
  await desk.getByRole("button", { name: "Delegate to Paws" }).click();
  await expect(desk.locator("#improvements-page")).toContainText("Delegated.");
  expect(starts).toHaveLength(1);

  const issueId = listImprovementDeliveries(w.db, retro)[0]!.remoteId!;
  insertQueuedItem(w.db, { id: "work-x", sessionKey: "session-a", now: END + 2_500 });
  w.db.run("UPDATE work_item SET linear_issue_id = ?, state = 'running' WHERE id = 'work-x'", [
    issueId,
  ]);
  await syncImprovementOutcomes({ db: w.db, linearFor: async () => linear, now: w.now });
  await expect(desk.locator(".improvement-detail-pane")).toContainText("Working", {
    timeout: 8_000,
  });
  w.db.run("UPDATE work_item SET state = 'merged' WHERE id = 'work-x'");
  w.db.run("INSERT INTO item_pull_request VALUES ('work-x', 42, 'https://gh/pull/42', ?)", [END]);
  w.db.run(
    "INSERT INTO remote_merge_fact VALUES ('work-x', 'acme', 'a', 42, 'https://gh/pull/42', ?, ?)",
    [MERGE, END + 3_000],
  );
  await syncImprovementOutcomes({ db: w.db, linearFor: async () => linear, now: w.now });
  await expect(desk.locator("#improvements-page")).toContainText("Merged · awaiting verification", {
    timeout: 8_000,
  });
  await expect(desk.locator("#improvements-page")).toContainText(
    "does not prove the change is deployed",
  );
  await layout(desk, "awaiting-verification", 1440, "dark");
  await desk.getByLabel("What you checked").fill("Weekly retro push-recovery questions");
  await desk.waitForTimeout(5_500);
  await expect(desk.getByLabel("What you checked")).toHaveValue(
    "Weekly retro push-recovery questions",
  );
  await desk.getByLabel("What it showed").fill("None in the two retros after the merge.");
  await desk.getByLabel("Evidence link").fill("https://linear.app/kyku/document/retro");
  await desk.getByRole("button", { name: "Record" }).click();
  await expect(desk.locator("#improvements-page")).toContainText("Verification recorded.");
  await expect(desk.locator(".improvement-detail-pane")).toContainText("Verified");
  await layout(desk, "verified", 1440, "dark");
  expect(starts).toHaveLength(1);

  scheduleState = "failed";
  await visit(desk, "/dashboard/improvements");
  await expect(desk.getByRole("button", { name: "Retry generation" })).toBeVisible();
  await layout(desk, "generation-failed", 1440, "dark");
  await desk.getByRole("button", { name: "Retry generation" }).click();
  await expect(desk.locator("#improvements-page")).toContainText("Waiting for a runner", {
    timeout: 8_000,
  });
  await layout(desk, "waiting-for-runner", 1440, "dark");

  await other.context().close();
  await desk.waitForTimeout(1_000);
  const hidden = requests.length;
  await desk.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await desk.waitForTimeout(11_000);
  expect(requests.slice(hidden).filter((path) => path.startsWith("/api/"))).toEqual([]);
  expect(requests.filter((path) => path.startsWith("/api/status"))).toEqual([]);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ out, checked, starts, created: linear.created.length }, null, 2));
} finally {
  await browser.close();
  await server.stop(true);
}
