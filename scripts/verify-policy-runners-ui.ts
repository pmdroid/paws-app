import { statusFixture } from "../src/web/test/fixtures";
// The banner for a Closeout policy key the lowest online runner does not know, on the overview
// and the Merge queue page, against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-policy-runners-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
snapshot.policyRunnerWarnings = [
  {
    repository: "acme/platform",
    policyDigest: `sha256:${"4f".repeat(32)}`,
    runnerVersion: "0.1.48",
    keys: [
      { key: "items[].ci", needs: "0.1.53" },
      { key: "items[].recheck", needs: "0.1.53" },
    ],
    checkedAt: snapshot.generatedAt,
  },
];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session") return new Response(null, { status: 404 });
    if (path === "/api/runners")
      return Response.json({ setupRequired: false, workspaceReady: true, runners: [] });
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
try {
  for (const [name, path] of [
    ["overview", "/status"],
    ["merge-queue", "/status/merge-queue"],
  ] as const) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`http://127.0.0.1:${server.port}${path}`);
      const banner = page.getByRole("alert", {
        name: "Closeout policy needs a newer runner for acme/platform",
      });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("uses keys runner 0.1.48 does not know");
      await expect(banner).toContainText("items[].ci needs runner 0.1.53");
      await expect(banner).toContainText("items[].recheck needs runner 0.1.53");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) throw new Error(`${name} at ${width} px overflows by ${overflow} px`);
      await page.screenshot({
        path: join(directory, `policy-runners-${name}-${width}.png`),
        fullPage: false,
      });
      await page.close();
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
  server.stop(true);
}
