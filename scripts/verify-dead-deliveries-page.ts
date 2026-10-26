// The issue page listing a dead Linear question and a dead job, against the real status handler.
// Usage: bun run build:status && bun --no-env-file scripts/verify-dead-deliveries-page.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/web";
import { statusFixture } from "../src/web/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const item = snapshot.items.find((entry) => entry.runId !== null) ?? snapshot.items[0]!;
const at = (minutes: number) =>
  new Date(Date.parse(snapshot.generatedAt) - minutes * 60_000).toISOString();
snapshot.dead = [
  {
    itemId: item.id,
    kind: "outbox",
    target: "outbox:412",
    name: "linear.elicitation",
    attempts: 5,
    lastError: "Linear returned 503 Service Unavailable",
    at: at(40),
  },
  {
    itemId: item.id,
    kind: "job",
    target: "job:88",
    name: "run.resume",
    attempts: 10,
    lastError: "Runner agentbox did not answer within 60 s",
    at: at(12),
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
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/issues/${item.id}`);
    const section = page.locator("#dead-deliveries");
    await expect(
      section.getByRole("heading", { name: "Stopped after every attempt" }),
    ).toBeVisible();
    await expect(section.getByText("Linear question")).toBeVisible();
    await expect(section.getByText("Job run.resume")).toBeVisible();
    await expect(section.getByText(/Linear returned 503/)).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(directory, `dead-deliveries-${width}.png`),
      fullPage: false,
    });
    await page.close();
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
  await server.stop(true);
}
console.log(`Screenshots in ${directory}`);
