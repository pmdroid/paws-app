import { fixtureProvider, fullStatusFixture } from "../../src/web/test/fixtures";
// Captures the overview and Issues list read from the trimmed status list, and an issue page with
// its Closeout attempts read from the item detail, at desktop and 390 px, for visual proof.
// Usage: bun run build:status && bun --no-env-file test/local/status-list-browser.ts <evidence-directory>
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "status-list-evidence");
await mkdir(directory, { recursive: true });

const provider = fixtureProvider(fullStatusFixture());
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "admin",
        csrfToken: "status-list-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    return (
      (await handleStatusRequest(request, { provider, csrfToken: "status-list-fixture" })) ??
      new Response(null, { status: 404 })
    );
  },
});

const browser = await chromium.launch({ headless: true });
const observations: Record<string, unknown>[] = [];
try {
  const base = `http://127.0.0.1:${server.port}`;
  const list = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
  const detail = await (await fetch(`${base}/api/status/items/ENG-100`)).text();
  observations.push({
    listBytes: JSON.stringify(list).length,
    detailBytes: detail.length,
    listKeys: Object.keys(list),
    listVerdict: (list.verdicts as unknown[])[0],
  });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shots: string[] = [];
    const shoot = async (name: string) => {
      const file = join(directory, `${name}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    };
    await page.goto(`${base}/status/`);
    await page.getByText("Needs you").first().waitFor();
    await shoot("overview");
    await page.goto(`${base}/status/issues`);
    await page.locator(".issue-row").first().waitFor();
    await shoot("issues");
    await page.goto(`${base}/status/issues/ENG-100`);
    await page.locator('[aria-label="Closeout"]').waitFor();
    const attempts = await page.locator('[data-action="closeout-attempt"]').count();
    await shoot("issue-page-closeout");
    const overflow = Number(
      await page.evaluate(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth",
      ),
    );
    observations.push({ width, attempts, overflow, errors, shots });
    if (attempts < 2) throw new Error(`the issue page shows ${attempts} Closeout attempts`);
    if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px at ${width}`);
    if (errors.length) throw new Error(errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop(true);
  await writeFile(join(directory, "observations.json"), JSON.stringify(observations, null, 2));
}
