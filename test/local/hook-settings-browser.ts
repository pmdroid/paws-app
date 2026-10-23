// Screenshots Settings → Agents → Hooks at desktop width and 390 px, after adding a hook
// through the form. Run `bun run build:status` first. Prints the output directory.
import { chromium } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { migrate, openDatabase } from "../../src/db";
import { saveHook } from "../../src/db";
import { handleHookSettingsRequest, handleSkillSettingsRequest } from "../../src/settings";
import { addSkill, fakeSkillResolver } from "../../src/skills";
import { demoStatus } from "../../src/web/src/demo";

const root = resolve(import.meta.dir, "../..");
const output = mkdtempSync(join(tmpdir(), "paws-hook-settings-browser-"));
const db = openDatabase(join(output, "paws.db"));
migrate(db);
const resolver = fakeSkillResolver((request) => {
  const name = request.kind === "npm" ? request.package : "review-paws";
  return new Map([["SKILL.md", new TextEncoder().encode(`---\nname: ${name}\n---\n`)]]);
});
const skillsRoot = join(output, "skills");
await addSkill(
  { db, root: skillsRoot, resolver, now: Date.now() },
  { kind: "git", url: "https://github.com/pmdroid/skills.git", subfolder: "review-paws" },
  { agents: ["claude"] },
);
saveHook(
  db,
  {
    id: "hook_guard",
    event: "before_shell",
    matcher: null,
    command: '"$PAWS_SKILL_DIR/guard-secrets.sh"',
    timeoutSeconds: 10,
    agents: ["claude"],
    skill: "review-paws",
  },
  Date.now(),
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const asset = url.pathname.replace(/^\/(status\/)?assets\//, "");
    if (asset !== url.pathname && !asset.includes("/"))
      return new Response(Bun.file(`${root}/src/web/dist/assets/${asset}`));
    if (url.pathname === "/settings/agents")
      return new Response(
        (await Bun.file(`${root}/src/web/dist/index.html`).text()).replace(
          "</head>",
          '<meta name="paws-csrf" content="synthetic-csrf"></head>',
        ),
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname.endsWith("/config.json")) return Response.json({ engineUrl: url.origin });
    if (url.pathname === "/api/auth/session")
      return Response.json({
        userId: "person",
        user: { name: "Admin", email: "admin@example.test" },
        role: "admin",
        workspaceId: "workspace",
        csrfToken: "synthetic-csrf",
        authenticatedAt: Date.now(),
        workspaces: [{ id: "workspace", name: "Team workspace", role: "admin" }],
      });
    if (url.pathname === "/api/status") return Response.json({ ...demoStatus(), source: "live" });
    if (url.pathname === "/api/settings/skills")
      return (await handleSkillSettingsRequest(req, {
        db,
        root: skillsRoot,
        resolver,
        csrfToken: "synthetic-csrf",
        role: "admin",
        audit: () => {},
      }))!;
    if (url.pathname === "/api/settings/hooks")
      return (await handleHookSettingsRequest(req, {
        db,
        csrfToken: "synthetic-csrf",
        role: "admin",
        audit: () => {},
      }))!;
    if (url.pathname === "/api/settings/agents")
      return Response.json({
        defaults: {
          implementer: { agent: "claude", model: null },
          reviewer: { agent: "codex", model: null },
        },
        projects: [],
        merge: { closeoutAfterUpdate: false, ciFixAttempts: 3 },
      });
    if (url.pathname === "/api/runners/models") return Response.json({ catalogs: [] });
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.port}/settings/agents`);
  await page.getByRole("heading", { name: "Hooks" }).waitFor();
  await page.getByText('"$PAWS_SKILL_DIR/guard-secrets.sh"').waitFor();
  await page.getByLabel("Add a hook").selectOption("after_edit");
  await page.getByLabel("Command").fill("bun run fmt");
  await page.getByRole("button", { name: "Add hook" }).click();
  await page.getByText("Added the hook.").waitFor();
  const section = page.locator("#hook-settings");
  type Box = { scrollWidth: number; clientWidth: number; parentElement: Box | null };
  const scroll = () =>
    page.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: { documentElement: Box; querySelector(selector: string): Box | null };
      };
      const box = document.querySelector("#hook-settings table")?.parentElement;
      return {
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        table: box?.scrollWidth ?? 0,
        tableBox: box?.clientWidth ?? 0,
      };
    });
  // Put the Hooks heading just below the sticky header, then capture the viewport.
  const shoot = async (name: string) => {
    await section.evaluate((node) => {
      const element = node as unknown as { getBoundingClientRect(): { top: number } };
      const scope = globalThis as unknown as { scrollBy(x: number, y: number): void };
      scope.scrollBy(0, element.getBoundingClientRect().top - 120);
    });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${output}/${name}` });
  };
  const top = () =>
    page.evaluate(() =>
      (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0),
    );
  const desktop = await scroll();
  await shoot("hooks-desktop.png");
  await top();
  await page.screenshot({ path: `${output}/agents-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const widths = await scroll();
  await shoot("hooks-390.png");
  await top();
  await page.screenshot({ path: `${output}/agents-390.png`, fullPage: true });
  console.log(JSON.stringify({ output, desktop, widths }));
  for (const measured of [desktop, widths])
    if (measured.document > measured.viewport || measured.table > measured.tableBox)
      throw new Error(`Horizontal scroll: ${JSON.stringify(measured)}`);
} finally {
  await browser.close();
  server.stop(true);
}
