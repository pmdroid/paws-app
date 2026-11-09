import { chromium, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startDashboardFixture } from "../test/dashboard-fixture";

const out =
  process.argv[2] ?? join(process.env.TMPDIR ?? "/tmp", `paws-dashboard-ui-${Date.now()}`);
mkdirSync(out, { recursive: true });
const f = await startDashboardFixture();
const query = f.db.query.bind(f.db);
const prepare = f.db.prepare.bind(f.db);
let statements = 0;
f.db.query = ((sql: string) => (statements++, query(sql))) as typeof f.db.query;
f.db.prepare = ((sql: string) => (statements++, prepare(sql))) as typeof f.db.prepare;

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

async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.setExtraHTTPHeaders({ cookie: f.cookie });
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
  const before = { requests: requests.length, statements };
  await page.goto(`${f.origin}${f.fill(path)}`);
  await expect(page.locator("#content h1").first()).toHaveText(heading);
  await page.waitForTimeout(5_600);
  const seen = requests.slice(before.requests);
  visits.push({
    page: name,
    width,
    requests: seen.length,
    bytes: seen.reduce((sum, request) => sum + request.bytes, 0),
    statements: statements - before.statements,
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

try {
  for (const width of [1440, 390]) {
    const page = await open(width);
    const resources = (seen: Request[]) => [
      ...new Set(seen.map((request) => request.path.split("?")[0])),
    ];
    const pages: Array<[string, string, string, string[]]> = [
      ["overview", "/", "Overview", ["/api/overview"]],
      ["issues", "/dashboard/issues", "Issues", ["/api/issues"]],
      ["issue", "/dashboard/issues/PAS-1", "Issues", ["/api/issues/PAS-1"]],
      ["questions", "/dashboard/questions", "Questions", ["/api/questions"]],
      ["question", "/dashboard/questions/q-PAS-1", "Questions", ["/api/questions/q-PAS-1"]],
      ["merge-queue", "/dashboard/merge-queue", "Merge queue", ["/api/merge-queue"]],
      ["evidence", "/dashboard/evidence", "Evidence", ["/api/evidence"]],
      [
        "evidence-file",
        "/dashboard/evidence/{evidence}",
        "PAS-1.png",
        [`/api/evidence/${f.evidence["PAS-1"]}/metadata`],
      ],
    ];
    for (const [name, path, heading, expected] of pages) {
      const seen = await visit(page, width, name, path, heading);
      const read = resources(seen).filter((resource) => PAGE_RESOURCE.test(resource));
      expect([name, read]).toEqual([name, expected]);
      const loads = seen.filter((request) => request.path === expected[0]).length;
      if (name.startsWith("evidence")) expect([name, loads]).toEqual([name, 1]);
      else expect([name, loads > 1]).toEqual([name, true]);
    }
    await page.route("**/api/settings/agents", (route) =>
      route.fulfill({
        json: {
          defaults: {
            implementer: { agent: "claude", model: "opus" },
            reviewer: { agent: "codex", model: "gpt-5.4" },
          },
          projects: [],
          presets: {
            Opus: { agent: "claude", model: "opus", effort: "high" },
            Codex: { agent: "codex", model: "gpt-5.4", effort: "high" },
          },
        },
      }),
    );
    await page.route("**/api/runners/models", (route) =>
      route.fulfill({
        json: {
          catalogs: [
            {
              agent: "claude",
              updatedAt: 1,
              efforts: [{ id: "high", name: "High" }],
              models: [{ id: "opus", name: "Opus", efforts: [{ id: "high", name: "High" }] }],
            },
            {
              agent: "codex",
              updatedAt: 1,
              efforts: [{ id: "high", name: "High" }],
              models: [{ id: "gpt-5.4", name: "GPT 5.4", efforts: [{ id: "high", name: "High" }] }],
            },
          ],
        },
      }),
    );
    await visit(page, width, "settings-agents", "/dashboard/settings/agents", "Agents");
    await expect(page.locator("#preset-0-name")).toHaveValue("Opus");
    await expect(page.locator("#preset-1-name")).toHaveValue("Codex");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.unroute("**/api/settings/agents");
    await page.unroute("**/api/runners/models");
    for (const [name, path, heading] of [
      ["runners", "/dashboard/runners", "Runners"],
      ["findings", "/dashboard/findings", "Findings"],
      ["settings-brief", "/dashboard/settings/brief", "Agent instructions"],
      ["settings-workspace", "/dashboard/settings/workspace", "Workspace access"],
    ] as const)
      await visit(page, width, name, path, heading);
    expect(requests.filter((request) => request.path.startsWith("/api/status"))).toEqual([]);

    current = `links@${width}`;
    await follow(
      page,
      "/status/issues/PAS-1?from=linear#question",
      "/dashboard/issues/PAS-1?from=linear#question",
      "PAS-1",
    );
    await follow(page, "/status/runs/{run}", "/dashboard/issues/PAS-1", "PAS-1");
    await follow(
      page,
      "/status/sessions/session-mine#question",
      "/dashboard/issues/PAS-1#question",
      "PAS-1",
    );
    await follow(page, "/dashboard/verdicts/PAS-1", "/dashboard/issues/PAS-1", "PAS-1");
    await follow(page, "/dashboard/#/issues/PAS-1", "/dashboard/issues/PAS-1", "PAS-1");
    await follow(page, "/status/questions/q-PAS-1", "/dashboard/questions/q-PAS-1", "Which way?");
    await follow(page, "/evidence/{evidence}", "/dashboard/evidence/{evidence}", "PAS-1");
    await follow(page, "/status/epics", "/dashboard/epics");
    await follow(page, "/status/runs", "/dashboard/issues");
    await follow(
      page,
      `/status/runs/${f.runs["PAS-2"]}`,
      `/dashboard/runs/${f.runs["PAS-2"]}`,
      "Link not found",
    );
    await follow(page, "/dashboard/issues/PAS-2", "/dashboard/issues/PAS-2", "Issue not found");

    current = `history@${width}`;
    await page.goto(`${f.origin}/dashboard/issues/PAS-1`);
    await page.goto(`${f.origin}/dashboard/questions`);
    await page.goBack();
    await expect(page).toHaveURL(`${f.origin}/dashboard/issues/PAS-1`);
    await expect(page.locator("#content")).toContainText("PAS-1");
    await page.goForward();
    await expect(page).toHaveURL(`${f.origin}/dashboard/questions`);
    await expect(page.locator("#content h1").first()).toHaveText("Questions");

    current = `stale@${width}`;
    let delayed = 0;
    await page.route(/\/api\/issues\/PAS-3$/, async (route) => {
      delayed++;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fulfill({ status: delayed === 1 ? 404 : 500, json: { error: "late" } });
    });
    await page.goto(`${f.origin}/dashboard/issues/PAS-1`);
    await expect(page.locator("#content")).toContainText("PAS-1");
    await page.evaluate(() => {
      history.pushState(null, "", "/dashboard/issues/PAS-3");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.evaluate(() => {
      history.pushState(null, "", "/dashboard/questions");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.locator("#content h1").first()).toHaveText("Questions");
    await page.waitForTimeout(2_000);
    await expect(page.locator("#content h1").first()).toHaveText("Questions");
    await expect(page.locator("#content")).not.toContainText("Issue not found");
    await page.unroute(/\/api\/issues\/PAS-3$/);

    current = `keyboard@${width}`;
    await page.goto(`${f.origin}/dashboard/issues`);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    if (width < 768) {
      await expect(async () => {
        await page.getByRole("button", { name: "Open navigation" }).click();
        await expect(page.getByRole("dialog", { name: "Paws navigation" })).toBeVisible({
          timeout: 1_000,
        });
      }).toPass();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
    }

    current = `transcript@${width}`;
    await page.goto(`${f.origin}/dashboard/runs/${f.runs["PAS-1"]}/transcript`);
    await expect(page.locator("body")).not.toBeEmpty();
    await page.screenshot({ path: join(out, `transcript-${width}.png`), fullPage: true });
    await page.context().close();
  }

  const page = await open(1440);
  current = "retry-closeout@1440";
  f.db.run("UPDATE question SET kind = 'closeout-help', options = ? WHERE id = 'q-PAS-1'", [
    JSON.stringify(["Retry Closeout"]),
  ]);
  await page.goto(`${f.origin}/dashboard/questions/q-PAS-1`);
  const card = page.locator("#q-q-PAS-1");
  const retry = card.getByRole("button", { name: /Retry Closeout/ });
  await expect(retry).toBeVisible();
  await page.screenshot({ path: join(out, "retry-closeout-1440.png"), fullPage: true });
  const posted = page.waitForResponse((response) =>
    response.url().endsWith("/api/questions/answer"),
  );
  await retry.click();
  const answered = await posted;
  expect(answered.status()).toBe(200);
  expect(answered.request().headers()["x-paws-csrf"]).toBe(f.csrfToken);
  expect(answered.request().postDataJSON()).toEqual({
    questionId: "q-PAS-1",
    answer: "Retry Closeout",
  });
  await expect(card.locator("[role=status]")).toHaveText("Answered");
  expect(f.answers).toEqual([
    {
      questionId: "q-PAS-1",
      answer: "Retry Closeout",
      answeredBy: "member",
      answeredByName: "Member",
    },
  ]);

  current = "revoked@1440";
  await page.goto(`${f.origin}/dashboard/issues/PAS-1`);
  await expect(page.locator("#content")).toContainText("Fixture PAS-1");
  f.revoke();
  await page.reload();
  await expect(page.locator("#content")).toContainText("Issue not found");
  await page.screenshot({ path: join(out, "revoked-1440.png"), fullPage: true });

  expect(errors).toEqual([]);
  await Bun.write(join(out, "network.json"), JSON.stringify(requests, null, 2));
  await Bun.write(join(out, "pages.json"), JSON.stringify(visits, null, 2));
  await Bun.write(join(out, "old-links.json"), JSON.stringify(links, null, 2));
  console.log(
    `PASS: dashboard pages, old links, history, stale responses, keyboard, Retry Closeout and revocation. Evidence in ${out}`,
  );
} finally {
  await browser.close();
  await f.close();
}
