import { chromium, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startDashboardFixture } from "../test/dashboard-fixture";
import { replaceWorkspaceRepositories } from "../src/db";

const out =
  process.argv[2] ?? join(process.env.TMPDIR ?? "/tmp", `paws-dashboard-ui-${Date.now()}`);
mkdirSync(out, { recursive: true });
const f = await startDashboardFixture();

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
type Request = { page: string; path: string; status: number; bytes: number };
const requests: Request[] = [];
const visits: Array<{
  page: string;
  width: number;
  requests: number;
  bytes: number;
  statements: number;
}> = [];
const links: Array<{ from: string; expected: string; reached: string }> = [];
const errors: string[] = [];
let current = "";
const PAGE_RESOURCE =
  /^\/api\/(overview|issues|questions|merge-queue|evidence(\/[^/]+\/metadata)?$|status)/;

const AGENT_ACCOUNTS = [
  ["A1", "claude", "Work", true, { refreshedAt: Date.now() - 600_000, runner: null }],
  ["A2", "claude", "Personal", false, null],
  ["A3", "codex", "Team", false, { refreshedAt: Date.now() - 60_000, runner: null }],
].map(([id, agent, label, extraUsage, credential], index) => ({
  ...{ id, agent, label, extraUsage, credential, signingIn: false, lease: null },
  usage: index === 0 ? { limits: [{ window: "5h", usedPercent: 62 }] } : null,
}));

async function open(width: number, cookie = f.cookie) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.setExtraHTTPHeaders({ cookie });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const body = await response.body().catch(() => Buffer.alloc(0));
    requests.push({
      page: current,
      path: `${url.pathname}${url.search}`,
      status: response.status(),
      bytes: body.byteLength,
    });
  });
  return page;
}

async function visit(page: Page, width: number, name: string, path: string, heading: string) {
  current = `${name}@${width}`;
  const before = { requests: requests.length, statements: f.statements() };
  await page.goto(`${f.origin}${f.fill(path)}`);
  await expect(page.locator("#content h1, .settings-link[aria-current]").first()).toHaveText(
    heading,
  );
  await page.waitForTimeout(5_600);
  const seen = requests.slice(before.requests);
  visits.push({
    page: name,
    width,
    requests: seen.length,
    bytes: seen.reduce((sum, request) => sum + request.bytes, 0),
    statements: f.statements() - before.statements,
  });
  await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage: true });
  return seen;
}

async function follow(page: Page, from: string, expected: string, text?: string) {
  await page.goto(`${f.origin}${f.fill(from)}`);
  await expect.poll(() => page.url().slice(f.origin.length)).toBe(f.fill(expected));
  if (text) await expect(page.locator("#content")).toContainText(text);
  links.push({
    from: f.fill(from),
    expected: f.fill(expected),
    reached: page.url().slice(f.origin.length),
  });
}

const REFUSAL = "Your GitHub account can't read acme/widgets.";
await replaceWorkspaceRepositories(f.db, {
  workspaceId: "workspace",
  actorId: "admin",
  repositories: [{ repository: "acme/app", teamId: "team" }],
  now: Date.now(),
});
try {
  for (const width of [1440, 390]) {
    const admin = await open(width, f.adminCookie);
    let groupingTime = "06:00";
    await admin.route("**/api/settings/findings", async (route) => {
      if (route.request().method() === "PUT")
        groupingTime = route.request().postDataJSON().groupingTime;
      await route.fulfill({ json: { grouping: true, groupingTime } });
    });
    await visit(admin, width, "findings-editable", "/dashboard/findings", "Findings");
    await admin.locator("#grouping-time").fill("13:45");
    await admin.getByRole("button", { name: "Save time", exact: true }).click();
    await expect(admin.locator("[data-findings-message]")).toContainText("Grouping time saved.");
    await admin.screenshot({ path: join(out, `findings-editable-${width}.png`), fullPage: true });
    await admin.route("**/api/runners", (route) =>
      route.fulfill({ json: { runners: [], serverVersion: null } }),
    );
    let vmSize = { cpu: 4, memoryGb: 8 };
    await admin.route("**/api/settings/member-vm", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        if (body.cpu < 1) {
          await route.fulfill({ status: 400, json: { error: "CPUs must be a positive integer." } });
          return;
        }
        vmSize = body;
      }
      await route.fulfill({ json: vmSize });
    });
    await visit(admin, width, "runners-editable", "/dashboard/runners", "Runners");
    await admin.locator("#vm-size-cpu").fill("6");
    await admin.getByRole("button", { name: "Save VM size", exact: true }).click();
    await expect(admin.locator("#content")).toContainText("Member VM size saved.");
    await admin.locator("#vm-size-cpu").fill("-1");
    await admin.getByRole("button", { name: "Save VM size", exact: true }).click();
    await expect(admin.getByRole("alert")).toContainText("CPUs must be a positive integer.");
    await expect(admin.locator("#vm-size-cpu")).toHaveValue("-1");
    await admin.screenshot({ path: join(out, `runners-editable-${width}.png`), fullPage: true });

    await admin.context().close();
  }
} finally {
  await browser.close();
  await f.close();
}
