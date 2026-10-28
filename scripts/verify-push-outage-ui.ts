import { statusFixture } from "../src/web/test/fixtures";
// The push outage banner on the overview and the Merge queue page, against the real status
// handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-push-outage-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const at = (minutes: number) =>
  new Date(Date.parse(snapshot.generatedAt) + minutes * 60_000).toISOString();
snapshot.pushOutages = [
  {
    repository: "acme/platform",
    since: at(-77),
    lastError:
      "remote: Permission to acme/platform.git denied to paws-helper[bot].\nfatal: unable to access 'https://github.com/acme/platform.git/': The requested URL returned error: 403",
    nextProbeAt: at(4),
    installationUrl: "https://github.com/settings/installations/22",
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
      const banner = page.getByRole("alert", { name: "Push outage on acme/platform" });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("GitHub refuses pushes from the Paws app since ");
      await expect(banner).toContainText("Pushes wait and retry.");
      await expect(banner).toContainText("denied to paws-helper[bot].");
      await expect(
        banner.getByRole("link", { name: "Check the App's permissions and repository access" }),
      ).toHaveAttribute("href", "https://github.com/settings/installations/22");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) throw new Error(`${name} at ${width} px overflows by ${overflow} px`);
      await page.screenshot({
        path: join(directory, `push-outage-${name}-${width}.png`),
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
