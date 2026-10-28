import { fixtureProvider, fullStatusFixture } from "../../src/web/test/fixtures";
// Captures the run page while a cleanup block holds its replies, with Clear stuck agent offered to
// an owner, at desktop and 390 px in light and dark, and fails on horizontal scroll or page errors.
// Usage: bun run build:status && bun --no-env-file test/local/stuck-agent-browser.ts <evidence-directory>
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLEANUP_BLOCKED_NOTICE } from "../../src/db";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "stuck-agent-evidence");
await mkdir(directory, { recursive: true });

const snapshot = fullStatusFixture();
snapshot.source = "live";
snapshot.runs = snapshot.runs.map((run) =>
  run.id === "r-102" ? { ...run, runner: "agentbox" } : run,
);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "stuck-agent-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    if (path === "/api/execution-controls") {
      if (request.method === "POST")
        return Response.json({ error: "Fixture does not apply actions." }, { status: 409 });
      return Response.json({
        available: true,
        itemId: "ENG-102",
        actions: ["stop", "pause", "clear_stuck_agent"],
        notice: CLEANUP_BLOCKED_NOTICE,
      });
    }
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
        csrfToken: "stuck-agent-fixture",
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
const observations: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.emulateMedia({ colorScheme: scheme });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/status/#/runs/r-102`);
      await page.getByRole("button", { name: "Clear stuck agent", exact: true }).waitFor();
      await page.getByText(CLEANUP_BLOCKED_NOTICE).waitFor();
      // A string expression, because this file type-checks without the DOM library.
      const overflow = Number(
        await page.evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      );
      const name = `stuck-agent-${width}-${scheme}.png`;
      await page.screenshot({ path: join(directory, name), fullPage: width < 768 });
      observations.push({ name, width, scheme, overflow, errors });
      await page.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
await writeFile(
  join(directory, "stuck-agent-observations.json"),
  `${JSON.stringify(observations, null, 2)}\n`,
);
console.log(JSON.stringify(observations));
const failed = observations.filter(
  (entry) => (entry.overflow as number) > 0 || (entry.errors as string[]).length,
);
if (failed.length) {
  console.error("Horizontal overflow or page errors:", JSON.stringify(failed));
  process.exit(1);
}
