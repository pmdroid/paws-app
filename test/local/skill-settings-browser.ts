import { statusFixture } from "../fixtures/status";
// Screenshots Settings → Agents → Skills at desktop width and 390 px, after adding a skill
// through the form. Run `bun run build:status` first. Prints the output directory.
import { chromium } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { migrate, openDatabase } from "../../src/db";
import { handleSkillSettingsRequest } from "../../src/settings";
import { addSkill, fakeSkillResolver } from "../../src/skills";

const root = resolve(import.meta.dir, "../..");
const output = mkdtempSync(join(tmpdir(), "paws-skill-settings-browser-"));
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
    if (url.pathname === "/api/status")
      return Response.json({ ...statusFixture(), source: "live" });
    if (url.pathname === "/api/settings/skills")
      return (await handleSkillSettingsRequest(req, {
        db,
        root: skillsRoot,
        resolver,
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
  await page.getByRole("heading", { name: "Skills" }).waitFor();
  await page.getByText("review-paws").first().waitFor();
  await page.getByLabel("Add a skill").fill("impeccable@2.4.1");
  await page.getByLabel("Grok").uncheck();
  await page.getByRole("button", { name: "Add skill" }).click();
  await page.getByText("Added impeccable 2.4.1.").waitFor();
  const section = page.locator("#skill-settings");
  type Box = { scrollWidth: number; clientWidth: number; parentElement: Box | null };
  const scroll = () =>
    page.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: { documentElement: Box; querySelector(selector: string): Box | null };
      };
      const box = document.querySelector("#skill-settings table")?.parentElement;
      return {
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        table: box?.scrollWidth ?? 0,
        tableBox: box?.clientWidth ?? 0,
      };
    });
  const desktop = await scroll();
  await section.screenshot({ path: `${output}/skills-desktop.png` });
  await page.screenshot({ path: `${output}/agents-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const widths = await scroll();
  await section.screenshot({ path: `${output}/skills-390.png` });
  // The section screenshot scrolls it into view; the full page starts at the top.
  await page.evaluate(() =>
    (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0),
  );
  await page.screenshot({ path: `${output}/agents-390.png`, fullPage: true });
  console.log(JSON.stringify({ output, desktop, widths }));
  for (const measured of [desktop, widths])
    if (measured.document > measured.viewport || measured.table > measured.tableBox)
      throw new Error(`Horizontal scroll: ${JSON.stringify(measured)}`);
} finally {
  await browser.close();
  server.stop(true);
}
