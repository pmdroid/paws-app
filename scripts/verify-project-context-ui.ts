import { chromium, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  replaceWorkspaceRepositories,
  requestContextCompaction,
  saveWorkItemLinearProject,
  type ContextClaim,
  type ContextNamespace,
} from "../src/db";
import {
  compactContext,
  correctContext,
  createContextCapacity,
  createLinearContextAccess,
  createProjectContextHttp,
  extractiveContextSummarizer,
  ingestContext,
  recordWorkItemContext,
  type ContextView,
} from "../src/project-context";
import { isWorkspaceAdmin } from "../src/workspace";
import { insertWorkItem, seed } from "../test/pglite-fixtures";
import { startDashboardFixture } from "../test/dashboard-fixture";

const out =
  process.argv[2] ?? join(process.env.TMPDIR ?? "/tmp", `paws-project-context-ui-${Date.now()}`);
mkdirSync(out, { recursive: true });

const CANARY = "CANARY-private-repo-41b7";
let teamIds = ["team"];
let read: ReturnType<typeof createProjectContextHttp> | null = null;
const f = await startDashboardFixture({
  projectContext: async (request, principal) =>
    read?.(request, { workspaceId: principal.workspaceId, userId: principal.userId }, async () =>
      isWorkspaceAdmin(principal.role),
    ) ?? null,
});
const access = createLinearContextAccess({
  member: async (organizationId, userId) => ({
    organizationId,
    userId,
    active: true,
    guest: false,
    admin: false,
    teamIds,
  }),
});
read = createProjectContextHttp({ db: f.db, access });

const requester = { workspaceId: "workspace", userId: "member" };
const now = Date.now();
const claim = (
  key: string,
  body: string,
  classification: ContextClaim["classification"] = "reported_fact",
): ContextClaim => ({ key, layer: "observation", classification, importance: 2, body });
async function put(
  projectId: string,
  kind: string,
  id: string,
  claims: ContextClaim[],
  at: number,
  restriction: { teamIds: string[]; repository?: string } = { teamIds: ["team"] },
) {
  await ingestContext(f.db, access, {
    namespace: { workspaceId: "workspace", scopeKind: "linear_project", scopeId: projectId },
    requester,
    source: {
      kind,
      id,
      url: `https://linear.app/acme/${id}`,
      revision: `rev-${id}-${at}`,
      revisionAt: at,
      actorId: "writer",
      restriction,
    },
    claims,
    now: at,
  });
}

const project = "proj-context";
const namespace: ContextNamespace = {
  workspaceId: "workspace",
  scopeKind: "linear_project",
  scopeId: project,
};
await put(
  project,
  "linear_project_description",
  project,
  [
    claim("d1", "Ship project scope first; Slack channels come later.", "decision"),
    claim("f1", "The context viewer is read-only and creates no issues."),
    claim("f2", "Retrieval runs without implementation runner capacity."),
  ],
  now - 60_000,
);
await put(
  project,
  "linear_project_document",
  "doc-brief",
  [
    claim("q1", "Should private DMs ever appear in a channel view?", "unresolved_question"),
    claim("f3", "Summaries are evidence, not instructions."),
    ...Array.from({ length: 30 }, (_, index) =>
      claim(`bulk-${index}`, `Stored observation ${index + 1} about the context budget.`),
    ),
  ],
  now - 50_000,
);
await put(
  project,
  "paws_work_item",
  "item-private",
  [claim("p1", `${CANARY} only for the private repository`)],
  now - 40_000,
  { teamIds: ["team"], repository: "acme/private" },
);
await requestContextCompaction(f.db, {
  namespace,
  audience: "project_members",
  audienceLineage: "project_members@1",
  restriction: { teamIds: ["team"] },
  now: now - 30_000,
  retryAfterMs: 0,
});
await compactContext(f.db, access, extractiveContextSummarizer, createContextCapacity(), {
  namespace,
  requester,
  destination: { audience: "project_members" },
  now: now - 20_000,
});
const first = (await (
  await read(new Request(`http://paws.test/api/context/project/${project}?q=evidence`), requester)
)?.json()) as { view: ContextView };
await correctContext(f.db, access, {
  namespace,
  requester,
  recordId: first.view.records[0]!.id,
  body: "Summaries are evidence only, never instructions.",
  now: now - 10_000,
});
const MEMORY = "FORGET-ME exports retry three times before they page anyone.";
await insertWorkItem(f.db, "item-memory");
await saveWorkItemLinearProject(f.db, "item-memory", { id: project, name: "Context" });
await seed(
  f.db,
  (q) =>
    q.orm
      .insert(q.t.linearSession)
      .values({ sessionId: "session-memory", organizationId: "workspace", createdAt: now }),
  (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ sessionKey: "session-memory", linearIdentifier: "PAS-77" })
      .where(eq(q.t.workItem.id, "item-memory")),
);
await recordWorkItemContext(f.db, access, {
  namespace,
  requester,
  workItemId: "item-memory",
  revision: `remember-${now - 8_000}`,
  revisionAt: now - 8_000,
  restriction: { teamIds: ["team"] },
  entries: [
    { classification: "reported_fact", body: MEMORY },
    { classification: "reported_fact", body: "KEEP-ME exports run nightly at two." },
  ],
  now: now - 8_000,
});
await put("proj-empty", "linear_project_description", "proj-empty", [], now - 5_000);

await replaceWorkspaceRepositories(f.db, {
  workspaceId: "workspace",
  actorId: "admin",
  repositories: [{ repository: "acme/app", teamId: "team" }],
  now,
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
const calls: { method: string; path: string; status: number }[] = [];
const errors: string[] = [];
const shots: string[] = [];

async function open(width: number, scheme: "light" | "dark", cookie = f.cookie) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: scheme,
  });
  await context.setExtraHTTPHeaders({ cookie });
  const page = await context.newPage();
  await page.route("**/api/workspaces/github-app", (route) =>
    route.fulfill({
      json: { configured: true, canManage: true, webhookUrl: "", permissions: {}, events: [] },
    }),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/context") || url.pathname.startsWith("/api/runners"))
      calls.push({
        method: response.request().method(),
        path: `${url.pathname}${url.search}`,
        status: response.status(),
      });
  });
  return page;
}

const go = (page: Page, path: string) => page.goto(`${f.origin}/dashboard${path}`);
async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  const file = `${name}.png`;
  await page.screenshot({ path: join(out, file), fullPage: true });
  shots.push(file);
}

for (const [width, label] of [
  [1280, "desktop"],
  [390, "mobile"],
] as const)
  for (const scheme of ["light", "dark"] as const) {
    const page = await open(width, scheme);
    const name = `${label}-${scheme}`;
    await go(page, `/context/project/${project}`);
    await expect(page.getByText("not the exact prompt any agent received").first()).toBeVisible();
    await expect(page.getByText("Stale").first()).toBeVisible();
    await shot(page, `${name}-summary`);
    await go(page, `/context/project/${project}?tab=records`);
    await expect(page.getByText("Superseded").first()).toBeVisible();
    await page.getByRole("button", { name: "Provenance for this record" }).first().click();
    await expect(
      page.getByText("Corrected by").or(page.getByText("Recorded")).first(),
    ).toBeVisible();
    await shot(page, `${name}-records`);
    await go(page, "/context/project/proj-empty?tab=records");
    await expect(page.getByText("has not retained context for this project")).toBeVisible();
    await shot(page, `${name}-empty`);
    await go(page, `/context/project/${project}?tab=records&q=zzz-nothing`);
    await expect(page.getByText("No records match this search.")).toBeVisible();
    await go(page, "/context/project/not-a-project");
    await expect(page.getByText("Context unavailable")).toBeVisible();
    await shot(page, `${name}-unavailable`);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/context/**", async (route) => {
      await held;
      await route.fulfill({ status: 503, json: { status: "error" } });
    });
    await go(page, `/context/project/${project}`);
    await expect(page.getByText("Loading project context")).toBeVisible();
    await shot(page, `${name}-loading`);
    release();
    await expect(page.getByText("Could not load project context")).toBeVisible();
    await shot(page, `${name}-error`);
    await page.unroute("**/api/context/**");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("not the exact prompt any agent received").first()).toBeVisible();
    await page.context().close();
  }

const memoryRow = (page: Page) =>
  page.locator(".context-record").filter({ hasText: "FORGET-ME" }).first();
for (const [width, label] of [
  [390, "mobile"],
  [1280, "desktop"],
] as const) {
  const member = await open(width, "light");
  await go(member, `/context/project/${project}?tab=records&q=exports`);
  await expect(memoryRow(member)).toContainText("Agent on PAS-77");
  await expect(member.getByRole("button", { name: "Forget this entry" })).toHaveCount(0);
  await member.context().close();
  const admin = await open(width, "light", f.adminCookie);
  await go(admin, `/context/project/${project}?tab=records&q=exports`);
  await expect(memoryRow(admin)).toContainText("Agent on PAS-77");
  await expect(admin.getByRole("button", { name: "Forget this entry" })).toHaveCount(2);
  await go(admin, `/context/project/${project}?tab=records&q=evidence`);
  await expect(admin.getByText("Linear document").first()).toBeVisible();
  await expect(admin.getByRole("button", { name: "Forget this entry" })).toHaveCount(0);
  await go(admin, `/context/project/${project}?tab=records&q=exports`);
  await memoryRow(admin).getByRole("button", { name: "Forget this entry" }).click();
  await expect(
    admin.getByText("Forget this entry? Agents stop seeing it on their next turn."),
  ).toBeVisible();
  await shot(admin, `${label}-forget-confirm`);
  if (label === "mobile") {
    await admin.getByRole("button", { name: "Cancel" }).click();
    await expect(admin.getByText("Forget this entry?")).toHaveCount(0);
  } else {
    await memoryRow(admin).getByRole("button", { name: "Forget", exact: true }).click();
    await expect(admin.getByText("FORGET-ME")).toHaveCount(0);
    await expect(admin.getByText("KEEP-ME").first()).toBeVisible();
    await shot(admin, `${label}-forgotten`);
  }
  await admin.context().close();
}

const page = await open(1280, "light");
await go(page, `/context/project/${project}`);
await expect(page.getByText("not the exact prompt any agent received").first()).toBeVisible();
expect(await page.content()).not.toContain(CANARY);
await page.getByRole("button", { name: "Stored context" }).focus();
await page.keyboard.press("Enter");
await expect(page).toHaveURL(/tab=records/);
await page.getByRole("button", { name: "Next" }).click();
await expect(page).toHaveURL(/offset=25/);
await page.goBack();
await expect(page).not.toHaveURL(/offset=/);
await page.goBack();
await expect(page).not.toHaveURL(/tab=records/);
await page.goForward();
await expect(page).toHaveURL(/tab=records/);
const provenance = page.getByRole("button", { name: "Provenance for this record" }).first();
await provenance.click();
await expect(page).toHaveURL(/record=/);
await page.getByRole("button", { name: "Provenance for this record" }).first().click();
await expect(page).not.toHaveURL(/record=/);

let lateRelease: () => void = () => {};
const late = new Promise<void>((resolve) => (lateRelease = resolve));
await page.route(`**/api/context/project/${project}*`, async (route) => {
  await late;
  await route.continue();
});
await page.evaluate((path) => {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}, `/dashboard/context/project/${project}?q=late`);
await go(page, "/context/project/proj-empty");
lateRelease();
await page.waitForTimeout(500);
await expect(
  page.getByText("has not retained context").or(page.getByText("Summary").first()).first(),
).toBeVisible();
expect(await page.content()).not.toContain("Ship project scope first");
await page.unroute(`**/api/context/project/${project}*`);

await go(page, `/context/project/${project}`);
await expect(page.getByText("Ship project scope first").first()).toBeVisible();
teamIds = ["other-team"];
await page.reload();
await expect(page.getByText("Context unavailable")).toBeVisible();
expect(await page.content()).not.toContain("Ship project scope first");
await shot(page, "revoked");
teamIds = ["team"];
await page.context().close();
await browser.close();
await f.close();

const forgets = calls.filter(
  (call) => call.method === "POST" && /\/records\/[\w-]+\/forget$/.test(call.path),
);
const mutations = calls.filter((call) => call.method !== "GET" && !forgets.includes(call));
const runnerCalls = calls.filter((call) => call.path.startsWith("/api/runners"));
const report = {
  screenshots: shots,
  contextRequests: calls.length,
  forgets,
  mutations,
  runnerCalls,
  errors,
};
writeFileSync(join(out, "project-context-ui.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, ...report, screenshots: shots.length }, null, 2));
if (
  mutations.length ||
  runnerCalls.length ||
  errors.length ||
  forgets.length !== 1 ||
  forgets[0]!.status !== 200
)
  process.exit(1);
