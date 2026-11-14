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
try {
  for (const [name, cookie, text, width] of (
    [
      ["setup-admin", f.adminCookie, "Choose repositories"],
      ["setup-member", f.cookie, "An admin is still setting up Paws."],
      ["sign-in", "", "After setup, other people only need to sign in with Linear."],
    ] as const
  ).flatMap((screen) => [1440, 390].map((size) => [...screen, size] as const))) {
    current = `${name}@${width}`;
    const page = await open(width, cookie);
    await page.route("**/api/workspaces/github-connect", (route) =>
      route.fulfill({
        json: { status: "needs_repositories", canManage: true, requiresSignIn: false },
      }),
    );
    await page.route("**/api/workspaces/github-setup*", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 409, json: { error: REFUSAL } })
        : route.fulfill({
            json: {
              signedIn: true,
              login: "octo",
              installations: [{ id: "1", account: "acme" }],
              installationId: "1",
              repositories: [{ repository: "acme/app", private: true }],
              teams: [{ id: "team", name: "Team", key: "TEAM" }],
              mappings: [],
            },
          }),
    );
    for (const path of ["/dashboard", "/dashboard/settings/merging", "/dashboard/runners"]) {
      await page.goto(f.origin + path);
      await expect(page.locator("#content")).toContainText(text);
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
      await expect(page.locator("[data-setup-github] #workspace-github-integration")).toHaveCount(
        name === "setup-admin" ? 1 : 0,
      );
    }
    if (name === "setup-admin") {
      await page.getByLabel("Match acme/app to Team").check();
      await page.getByRole("button", { name: "Save repository access" }).click();
      await expect(page.locator("[data-setup-github] [data-feedback]")).toHaveText(REFUSAL);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage: true });
    await page.context().close();
  }
  await replaceWorkspaceRepositories(f.db, {
    workspaceId: "workspace",
    actorId: "admin",
    repositories: [{ repository: "acme/app", teamId: "team" }],
    now: Date.now(),
  });
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
    const admin = await open(width, f.adminCookie);
    let merging = {
      default: { order: "queue", mainMoved: "overlap" },
      sessionDone: "pull_request",
      sessionQuietMinutes: 10,
    };
    await admin.route("**/api/settings/merging", async (route) => {
      if (route.request().method() === "PUT")
        merging = { ...merging, ...route.request().postDataJSON() };
      await route.fulfill({ json: merging });
    });
    await visit(admin, width, "settings-merging", "/dashboard/settings/merging", "Merging");
    await admin.locator('[name="session-done"][value="settled"]').check();
    const quiet = admin.locator('[name="session-quiet"]');
    await expect(quiet).toHaveValue("10");
    for (const value of ["0", "121", "1.5", ""]) {
      await quiet.fill(value);
      expect(await quiet.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
    }
    await quiet.fill("17");
    const savedSession = admin.waitForRequest(
      (request) => request.method() === "PUT" && request.url().endsWith("/api/settings/merging"),
    );
    await admin.locator('#merge-settings-form button[type="submit"]').click();
    expect((await savedSession).postDataJSON()).toMatchObject({
      sessionDone: "settled",
      sessionQuietMinutes: 17,
    });
    await expect(admin.getByText("Merging settings saved.", { exact: false })).toBeVisible();
    await admin.reload();
    await expect(admin.locator('[name="session-done"][value="settled"]')).toBeChecked();
    await expect(admin.locator('[name="session-quiet"]')).toHaveValue("17");
    await admin.locator("#merge-session").scrollIntoViewIfNeeded();
    await admin.screenshot({
      path: join(out, `settings-merging-settled-${width}.png`),
      fullPage: true,
    });

    await admin.route("**/api/settings/agents", (route) =>
      route.fulfill({
        json: {
          defaults: {
            implementer: { agent: "claude", model: "opus" },
            reviewer: { agent: "codex", model: "gpt-5.4" },
          },
          presets: {
            Opus: {
              implementer: { agent: "claude", model: "opus", effort: "high" },
              reviewer: { agent: "codex", model: "gpt-5.4", effort: "high" },
            },
            Codex: {
              implementer: { agent: "codex", model: "gpt-5.4", effort: "high" },
              reviewer: { agent: "claude", model: "opus", effort: "high" },
            },
          },
        },
      }),
    );
    await admin.route("**/api/runners/models", (route) =>
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
    await visit(admin, width, "settings-agents", "/dashboard/settings/agents", "Agents");
    await expect(admin.locator("#preset-0-name")).toHaveValue("Opus");
    await expect(admin.locator("#preset-1-name")).toHaveValue("Codex");
    await expect(admin.locator(".settings-nav a")).toHaveCount(10);
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await admin.unroute("**/api/settings/agents");
    await admin.unroute("**/api/runners/models");
    await page.route("**/api/runners", (route) =>
      route.fulfill({
        json: {
          runners: [
            {
              id: "agent-summary-runner",
              name: "build-box",
              codingAgents: ["claude", "codex", "grok"].map((agent) => ({
                agent,
                current: "1",
              })),
              agents: [{ agent: "claude", status: "signed_out", checkedAt: 1 }],
            },
          ],
        },
      }),
    );
    await page.route("**/api/runners/agent-accounts", (route) =>
      route.fulfill({
        json: {
          accounts: [
            { agent: "claude", credential: {}, extraUsage: false, usage: null },
            { agent: "codex", credential: null, extraUsage: false, usage: null },
            {
              agent: "grok",
              credential: {},
              usage: {
                limits: [{ window: "5h", usedPercent: 100, resetsAt: Date.now() + 3_600_000 }],
              },
            },
          ].map((account) => ({ ...account, id: account.agent, label: account.agent })),
        },
      }),
    );
    for (const [name, path, heading] of [
      ["findings", "/dashboard/findings", "Findings"],
      ["runners", "/dashboard/runners", "Runners"],
    ] as const)
      await visit(page, width, name, path, heading);
    const summary = page.getByRole("link", {
      name: /Claude signed in.*Codex needs sign-in.*Grok quota cooldown until/,
    });
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `runner-agents-${width}.png`), fullPage: true });
    await summary.click();
    await expect(page).toHaveURL(`${f.origin}/dashboard/settings/agent-accounts`);
    await page.unroute("**/api/runners/agent-accounts");
    for (const [name, path, heading] of [
      ["settings-brief", "/dashboard/settings/brief", "Agent instructions"],
      ["settings-workspace", "/dashboard/settings/workspace", "Workspace access"],
    ] as const)
      await visit(admin, width, name, path, heading);
    await visit(page, width, "settings-member", "/dashboard/settings/merging", "Your account");
    await expect(page.locator(".settings-nav a")).toHaveText([
      "Agent accounts",
      "Integrations",
      "Your account",
    ]);
    await expect(page.locator("#merge-settings")).toHaveCount(0);
    for (const viewer of [admin, page])
      await viewer.route("**/api/workspaces/github-connect", (route) =>
        route.fulfill({
          json: {
            status: "connected",
            canManage: viewer === admin,
            requiresSignIn: false,
            repositoryCount: 1,
            lastDelivery: { event: "check_suite", receivedAt: Date.now() },
          },
        }),
      );
    await admin.route("**/api/workspaces/github-setup*", (route) =>
      route.fulfill({
        json: {
          signedIn: true,
          cached: true,
          installationId: "1",
          repositories: [
            { repository: "acme/app", private: true },
            { repository: "acme/site", private: false },
          ],
          teams: [{ id: "team", name: "Team", key: "TEAM" }],
          mappings: [{ repository: "acme/app", teamId: "team" }],
          refreshedAt: Date.now() - 120_000,
        },
      }),
    );
    for (const [viewer, name] of [
      [admin, "integrations-admin"],
      [page, "integrations-member"],
    ] as const) {
      await visit(viewer, width, name, "/dashboard/settings/integrations", "Integrations");
      const github = viewer.locator("#workspace-github-integration");
      await expect(github.locator(".pill")).toHaveText("Connected");
      await expect(github).toContainText("acme");
      await expect(github.getByRole("button", { name: /Sign in|Refresh/ })).toHaveCount(0);
      if (viewer === admin) {
        await expect(github.getByLabel("Match acme/app to Team")).toBeChecked();
        await expect(github.getByLabel("Match acme/site to Team")).not.toBeChecked();
        await expect(github.getByRole("button", { name: "Save repository access" })).toBeVisible();
      } else {
        await expect(github.getByRole("list", { name: "Mapped repositories" })).toHaveText(
          "acme/app",
        );
        await expect(github.locator("input, select")).toHaveCount(0);
      }
      await viewer.unroute("**/api/workspaces/github-connect");
    }
    await admin.unroute("**/api/workspaces/github-setup*");
    for (const [reader, name, canManage] of [
      [admin, "settings-agent-accounts", true],
      [page, "settings-agent-accounts-member", false],
    ] as const) {
      await reader.route("**/api/runners/agent-accounts", (route) =>
        route.fulfill({ json: { canManage, accounts: AGENT_ACCOUNTS } }),
      );
      await visit(reader, width, name, "/dashboard/settings/agent-accounts", "Agent accounts");
      await expect(reader.locator("#agent-account-settings li")).toHaveCount(3);
      await expect(reader.locator("#agent-account-settings button")).toHaveCount(
        canManage ? 13 : 0,
      );
      await reader.unroute("**/api/runners/agent-accounts");
    }
    await admin.context().close();
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
  await f.db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.question)
        .set({ kind: "closeout-help", options: ["Retry Closeout"] })
        .where(eq(q.t.question.id, "q-PAS-1")),
    ),
  );
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
