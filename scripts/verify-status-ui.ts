import { chromium, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoStatus, handleStatusRequest } from "../src/web";

const directory = await mkdtemp(join(tmpdir(), "paws-status-ui-"));
const snapshot = demoStatus();
snapshot.source = "live";
let settings = {
  defaults: {
    implementer: { agent: "claude", model: null },
    reviewer: { agent: "codex", model: null },
  },
  projects: [],
};
let saves = 0;
let statusReads = 0;
const actions: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/status") statusReads++;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/settings/agents") {
      if (request.method === "PUT") {
        settings = await request.json();
        saves++;
      }
      return Response.json(settings);
    }
    if (path === "/api/runners")
      return Response.json({ setupRequired: true, workspaceReady: false, runners: [] });
    if (path === "/api/linear/sessions") return Response.json({ available: true, sessions: [] });
    if (path === "/api/execution-controls") {
      if (request.method === "POST") {
        const body = await request.json();
        actions.push(body.action);
        return Response.json({ ok: true });
      }
      return Response.json({ available: true, actions: ["pause", "stop"] });
    }
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
const pages = [
  ["Overview", ""],
  ["Issues", "/issues"],
  ["Projects", "/projects"],
  ["Questions", "/questions"],
  ["Runs", "/runs"],
  ["Runners", "/runners"],
  ["Agents", "/settings/agents"],
  ["Integrations", "/settings/integrations"],
  ["Workspace access", "/settings/workspace"],
  ["Your account", "/settings/account"],
  ["Audit history", "/settings/audit"],
] as const;
async function navigate(page: Page, name: string, width: number) {
  if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
  const nav =
    width < 768
      ? page
          .getByRole("dialog", { name: "Paws navigation" })
          .getByRole("navigation", { name: "Main navigation" })
      : page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name, exact: true }).click();
  if (width < 768)
    await expect(page.getByRole("dialog", { name: "Paws navigation" })).not.toBeVisible();
  await expect(page.locator("#content h1")).toHaveText(name);
  await expect(page.locator("#content h1")).toHaveClass(/sr-only/);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/`);
    await expect(page.locator("#content h1")).toHaveText("Overview");
    await expect(page.locator("#content h1")).toHaveClass(/sr-only/);
    await expect(page.locator("#linear-session-start")).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs you", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Working now", exact: true })).toBeVisible();
    await expect(page.locator(".overview-summary")).toHaveText(
      "2 need you · 1 working · 1 queued · 1 waiting to merge",
    );
    await expect(page.locator("#content")).not.toContainText("Recent events");
    await expect(page.locator("#content")).not.toContainText("Export job worker");
    await page.getByRole("link", { name: "Answer question: ENG-103", exact: true }).click();
    await expect(page).toHaveURL(/\/questions\/Q-41$/);
    await expect(page.locator("#q-Q-41")).toBeVisible();
    await page.goBack();
    await page.getByRole("link", { name: "Answer question: ENG-100", exact: true }).click();
    await expect(page).toHaveURL(/\/questions\/Q-40$/);
    await expect(page.locator("#q-Q-40")).toBeVisible();
    await page.goBack();
    await page.locator('.overview-work a[href="/status/runs/r-102"]').click();
    await expect(page).toHaveURL(/\/runs\/r-102$/);
    await expect(
      page.getByText("Task activity and agent transcript", { exact: true }),
    ).toBeVisible();
    await page.goBack();
    if (width < 768) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("dialog", { name: "Paws navigation" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    }
    for (const appearance of ["Dark", "Light"]) {
      await page
        .getByRole("combobox", { name: "Appearance", exact: true })
        .selectOption(appearance.toLowerCase());
      await expect(page.locator("html")).toHaveClass(new RegExp(appearance.toLowerCase()));
      await expect(page.getByRole("button", { name: "Engine", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
      await expect(page.locator("#banner")).not.toContainText("Status from");
      await expect(page.locator("#banner")).not.toContainText("Demo");
      await page.waitForTimeout(250);
      await page.screenshot({
        path: join(
          process.env.PAWS_UI_EVIDENCE_DIR ?? directory,
          `overview-${appearance.toLowerCase()}-${width}.png`,
        ),
        fullPage: true,
      });
      await page.reload();
      await expect(page.locator("html")).toHaveClass(new RegExp(appearance.toLowerCase()));
    }
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveClass(/light/);
    for (const [name, path] of pages) {
      await navigate(page, name, width);
      await expect
        .poll(() => new URL(page.url()).pathname.replace(/\/$/, ""))
        .toBe(`/status${path}`);
      if (width >= 768)
        await expect(
          page
            .getByRole("navigation", { name: "Main navigation" })
            .locator('[aria-current="page"]'),
        ).toHaveText(name);
      await expect(page.locator("#content h1")).toHaveCount(1);
    }
    await navigate(page, "Issues", width);
    await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Active", exact: true }).click();
    await expect(page.getByRole("button", { name: "Active", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    snapshot.items[0]!.title += " Refreshed.";
    await page.reload();
    await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.screenshot({
      path: join(process.env.PAWS_UI_EVIDENCE_DIR ?? directory, `issues-${width}.png`),
      fullPage: true,
    });
    await page.locator(".issue-list a").first().click();
    await expect(page).toHaveURL(/\/status\/issues\//);
    await expect(page.locator(".issue-head")).toBeVisible();
    await page.screenshot({
      path: join(process.env.PAWS_UI_EVIDENCE_DIR ?? directory, `issue-detail-${width}.png`),
      fullPage: true,
    });
    await page.goBack();
    await expect(page.locator("#content h1")).toHaveText("Issues");
    if (width < 768) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("dialog", { name: "Paws navigation" })).toBeVisible();
      await page.waitForTimeout(550);
      await page.screenshot({
        path: join(process.env.PAWS_UI_EVIDENCE_DIR ?? directory, "mobile-navigation.png"),
      });
      await page.setViewportSize({ width: 1024, height: 1000 });
      await expect(page.getByRole("dialog", { name: "Paws navigation" })).not.toBeVisible();
      await page.setViewportSize({ width, height: 1000 });
    }
    await navigate(page, "Runs", width);
    const runRows = page.locator("tr[data-run-id]");
    await expect(runRows).toHaveCount(snapshot.runs.length);
    await page.locator("summary", { hasText: /^Lead/ }).click();
    await page.getByRole("checkbox", { name: "Jonas Berg", exact: true }).check();
    await expect(page).toHaveURL(/\/status\/runs\?lead=Jonas\+Berg$/);
    await page.locator("summary", { hasText: /^Phase/ }).click();
    await page.getByRole("checkbox", { name: "Implementation", exact: true }).check();
    await page.getByRole("checkbox", { name: "Waiting to merge", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "Waiting to merge" })).toBeFocused();
    await expect(page).toHaveURL(/lead=Jonas\+Berg&phase=implementation&phase=merge$/);
    await expect(runRows).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Pull request 479", exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(process.env.PAWS_UI_EVIDENCE_DIR ?? directory, `runs-filters-open-${width}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(runRows).toHaveCount(2);
    await expect(page.locator("summary", { hasText: "Phase · 2" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(process.env.PAWS_UI_EVIDENCE_DIR ?? directory, `runs-filtered-${width}.png`),
      fullPage: true,
    });
    await page.goto(`http://127.0.0.1:${server.port}/status/runs?lead=Aisha+Khan&phase=complete`);
    await expect(page.getByText("No runs match these filters.")).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/status\/runs$/);
    await expect(runRows).toHaveCount(snapshot.runs.length);
    await page.locator(`a[href="/status/runs/${snapshot.runs[0]!.id}"]`).click();
    await page.getByRole("button", { name: "Pause item", exact: true }).click();
    await expect.poll(() => actions.includes("pause")).toBe(true);
    await page.getByText("Stop this item", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm stop", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Confirm stop", exact: true })).toHaveCount(0);
    await page.screenshot({
      path: join(process.env.PAWS_UI_EVIDENCE_DIR ?? directory, `runs-${width}.png`),
      fullPage: true,
    });
    const verified = snapshot.runs.find((run) =>
      snapshot.verdicts.some((verdict) => verdict.itemId === run.itemId),
    )!;
    await page.goto(`http://127.0.0.1:${server.port}/status/#/runs/${verified.id}`);
    await expect(page).toHaveURL(new RegExp(`/status/runs/${verified.id}$`));
    await expect(page.getByRole("heading", { name: "Closeout", exact: true })).toBeVisible();
    await page.getByText("Task activity and agent transcript", { exact: true }).click();
    await expect(page.getByRole("log", { name: "Agent transcript" })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Open full agent transcript", exact: true }),
    ).toHaveAttribute(
      "href",
      `http://127.0.0.1:${server.port}/api/runs/transcript?run=${verified.id}`,
    );
    await expect(page.getByRole("combobox", { name: "Candidate", exact: true })).toHaveCount(0);
    await page.locator('[data-action="toggle-check"]').first().click();
    await expect(
      page.locator('[data-action="toggle-check"][aria-expanded="true"]').first(),
    ).toBeVisible();
    // The Conversations page is gone: its old URL opens the issue list, which offers the form.
    await page.goto(`http://127.0.0.1:${server.port}/status/sessions`);
    await expect(page).toHaveURL(/\/status\/issues$/);
    await expect(page.getByRole("link", { name: "Conversations" })).toHaveCount(0);
    await expect(page.locator("#linear-session-start")).toBeVisible();
    expect(
      await page
        .locator("#linear-session-start")
        .evaluate((node) =>
          Boolean(
            node.compareDocumentPosition(document.querySelector("#content")!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
    ).toBe(true);
    await page.getByText("Start Linear session", { exact: true }).click();
    await page.getByRole("textbox", { name: "Issue or comment thread" }).fill("ENG-123");
    await page.reload();
    await page.getByText("Start Linear session", { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Issue or comment thread" })).toHaveValue("");
    await navigate(page, "Runners", width);
    await expect(page.locator("#linear-session-start")).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up remote runners" })).toBeVisible();
    await expect(page.getByText("curl -fsSL https://get.paws.boo/ | sudo sh")).toBeVisible();
    await page.getByRole("button", { name: "Check setup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check setup", exact: true })).toBeEnabled();
    await navigate(page, "Agents", width);
    await expect(page.getByRole("heading", { name: "Global defaults" })).toBeVisible();
    await page.locator("select#defaults-implementer-agent").selectOption("grok");
    await page.locator("#settings-repo").fill(`acme/ui-${width}`);
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    const inherit = page.locator("label").filter({ hasText: "Use global default" }).first();
    await inherit.click();
    await expect(page.locator('input[name="0-implementer-inherit"]')).not.toBeChecked();
    await inherit.click();
    await expect(page.getByRole("button", { name: "Test connection" })).toHaveCount(0);
    await expect(page.locator('#agent-settings a[href="/status/runners"]')).toBeVisible();
    if (width >= 768) {
      await page.goto(`http://127.0.0.1:${server.port}/status/runners`);
      await expect(page.getByRole("heading", { name: "Set up remote runners" })).toBeVisible();
      const reads = statusReads;
      await navigate(page, "Agents", width);
      await page.waitForTimeout(5_500);
      expect(statusReads).toBe(reads);
      await navigate(page, "Questions", width);
      await expect.poll(() => statusReads).toBeGreaterThan(reads);
      await navigate(page, "Agents", width);
    }
    await expect(page.locator("#defaults-implementer-model")).toBeDisabled();
    await expect(page.locator("#defaults-implementer-effort")).toBeDisabled();
    await expect(
      page.getByText("Sign in on a runner to load model choices.").first(),
    ).toBeVisible();
    await page.reload();
    await expect(page.locator("#defaults-implementer-model")).toHaveValue("");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Agent settings saved" }),
    ).toBeVisible();
    await page.goto(`http://127.0.0.1:${server.port}/status/runs/missing`);
    await expect(page.locator("#content")).toContainText("Run not found");
    await page.getByRole("combobox", { name: "Run", exact: true }).selectOption({ index: 1 });
    await expect(page.locator("#content")).not.toContainText("Run not found");
    const empty = {
      ...snapshot,
      items: [],
      runs: [],
      questions: [],
      verdicts: [],
      mergeQueue: [],
      events: [],
    };
    await page.route("**/api/status", (route) => route.fulfill({ json: empty }));
    await page.reload();
    for (const name of ["Overview", "Issues", "Questions", "Runs"]) {
      await navigate(page, name, width);
      await expect(page.locator("#content .empty")).toBeVisible();
    }
    await page.unroute("**/api/status");
    await page.route("**/api/status", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture unavailable" } }),
    );
    await page.reload();
    await expect(page.locator("#banner")).not.toContainText("Offline");
    await navigate(page, "Overview", width);
    await expect(page.locator("#banner")).toContainText("Offline");
    await navigate(page, "Agents", width);
    await expect(page.getByRole("heading", { name: "Global defaults" })).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem("paws.statusEngineUrl", "demo");
    });
    await page.reload();
    await navigate(page, "Overview", width);
    await expect(page.locator("#banner")).not.toContainText("fictional workspace");
    await page.route("**/api/auth/session", (route) => route.fulfill({ status: 401 }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to Paws", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    await page.getByText("Set up your first workspace", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Connect workspace", exact: true }),
    ).toBeVisible();
    await page.close();
  }
  const measurements: unknown[] = [];
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 768, height: 700 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 844, height: 390 },
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/status/`);
    await expect(page.locator("#content h1")).toHaveText("Overview");
    await expect(page.locator("#content h1")).toHaveClass(/sr-only/);
    for (const [name] of pages) {
      await navigate(page, name, viewport.width);
      const dimensions = await page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector(selector)?.getBoundingClientRect();
        const sidebar = rect('[data-slot="sidebar"]');
        const header = rect("header.sticky");
        const content = rect("#content");
        const buttons = [
          ...document.querySelectorAll<HTMLElement>(
            '#top button, [data-slot="input"], [data-slot="native-select"]',
          ),
        ]
          .filter((node) => node.getClientRects().length)
          .map((node) => ({
            name: node.getAttribute("name") ?? node.textContent,
            height: node.getBoundingClientRect().height,
          }));
        return {
          sidebar: sidebar ? { height: sidebar.height, right: sidebar.right } : null,
          documentHeight: document.documentElement.scrollHeight,
          viewport: innerHeight,
          headerLeft: header?.left,
          contentLeft: content?.left,
          overflow: document.documentElement.scrollWidth > innerWidth,
          buttons,
        };
      });
      expect(dimensions.overflow).toBe(false);
      for (const control of dimensions.buttons)
        expect(
          Math.abs(control.height - 44),
          `${viewport.width} ${name} ${control.name}`,
        ).toBeLessThan(1);
      if (viewport.width >= 768) {
        expect(
          Math.abs(dimensions.sidebar!.height - dimensions.documentHeight),
          `${viewport.width} ${name} full-page sidebar`,
        ).toBeLessThan(2);
        expect(dimensions.headerLeft).toBe(dimensions.sidebar!.right);
        expect(dimensions.contentLeft).toBeGreaterThan(dimensions.sidebar!.right);
      }
      measurements.push({
        width: viewport.width,
        height: viewport.height,
        page: name,
        ...dimensions,
      });
    }
    if (viewport.width >= 768) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const pinned = await page.locator('[data-slot="sidebar"] > div').boundingBox();
      expect(Math.abs(pinned!.y)).toBeLessThan(1);
      expect(Math.abs(pinned!.height - viewport.height)).toBeLessThan(1);
    }
    await page.close();
  }
  if (process.env.PAWS_UI_EVIDENCE_DIR)
    await Bun.write(
      join(process.env.PAWS_UI_EVIDENCE_DIR, "layout-measurements.json"),
      JSON.stringify(measurements, null, 2),
    );
  expect(saves).toBe(2);
  expect(settings.defaults.implementer).not.toHaveProperty("effort");
  expect(errors).toEqual([]);
  console.log(
    "PASS: all eleven pages via sidebar/mobile menu, path routes, legacy hash redirects, status reads only on work pages, active links, Back, deep links, issue filters, entity selection, empty/offline/login states, polling-safe forms, execution controls, settings save, and persistent Light/Dark/System at desktop/mobile widths. No browser errors or horizontal overflow.",
  );
} finally {
  await browser.close();
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
