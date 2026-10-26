import { statusFixture } from "../../src/web/test/fixtures";
// Captures an issue page showing its Linear project and the Issues page filtered by project,
// at desktop and 390 px, for visual proof.
// Usage: bun run build:status && bun --no-env-file test/local/issue-project-browser.ts <evidence-directory>
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "issue-project-evidence");
await mkdir(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const runtimes = { id: "linear-runtimes", name: "Paws runner runtimes with mise" };
for (const item of snapshot.items) if (item.id === "ENG-101") item.project = runtimes;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "issue-project-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "issue-project-fixture",
      })) ?? new Response(null, { status: 404 })
    );
  },
});

const browser = await chromium.launch({ headless: true });
const observations: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/status/issues/ENG-104`);
    await page.getByText("Audit log export").first().waitFor();
    const issueShot = join(directory, `issue-page-project-${width}.png`);
    await page.screenshot({ path: issueShot, fullPage: true });

    await page.goto(`http://127.0.0.1:${server.port}/status/issues`);
    const picker = page.locator("select[data-issue-project-filter]");
    await picker.waitFor();
    await picker.selectOption("linear-audit");
    const visible = await page
      .locator(".issue-row:visible")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-issue-id")));
    const overflow = Number(
      await page.evaluate(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth",
      ),
    );
    const listShot = join(directory, `issues-filtered-by-project-${width}.png`);
    await page.screenshot({ path: listShot, fullPage: true });
    const expected = snapshot.items
      .filter((item) => item.project?.id === "linear-audit")
      .map((item) => item.id);
    observations.push({ width, visible, expected, overflow, errors, issueShot, listShot });
    if (JSON.stringify(visible) !== JSON.stringify(expected))
      throw new Error(`filter showed ${visible.join(",")}, expected ${expected.join(",")}`);
    if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px at ${width}`);
    if (errors.length) throw new Error(errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
  await writeFile(join(directory, "observations.json"), JSON.stringify(observations, null, 2));
}
console.log(JSON.stringify(observations, null, 2));
