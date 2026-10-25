// Runners → Add a host for a workspace member: the button, the dialog and its one command.
// Usage: bun run build:status && bun --no-env-file scripts/verify-runner-add-host-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { demoStatus, handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const snapshot = demoStatus();
snapshot.source = "live";
const token = "Zq3_fixture-token-0123456789abcdefghijklmnop";
const minted: unknown[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "member",
        role: "member",
        csrfToken: "ui-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Member", email: "member@example.invalid" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: [], serverVersion: null, agentVersions: [] });
    if (path === "/api/runners/enrollments" && request.method === "POST") {
      minted.push(await request.json());
      return Response.json({
        token,
        expiresAt: Date.now() + 10 * 60_000,
        name: "build-box",
        config: {
          controlPlaneUrl: "https://paws.example.com",
          runnerApiUrl: "https://paws.example.com:8788",
          allowedRepositories: ["acme/app", "acme/api"],
        },
      });
    }
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
    await page.goto(`http://127.0.0.1:${server.port}/status/runners`);
    const add = page.getByRole("button", { name: "Add a host" });
    await expect(add).toBeVisible();
    await page.screenshot({
      path: join(directory, `runners-add-host-${width}.png`),
      fullPage: true,
    });
    await add.click();
    const dialog = page.getByRole("dialog", { name: "Add a host" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Host name").fill("build-box");
    await dialog.getByRole("button", { name: "Create command" }).click();
    const command = dialog.locator("#runner-enroll-command");
    await expect(command).toContainText("runner enroll --config /etc/paws-runner/config.json");
    await expect(command).toContainText(token);
    await expect(dialog.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: join(directory, `runners-add-host-command-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }
  expect(minted).toEqual([{ name: "build-box" }, { name: "build-box" }]);
  expect(errors).toEqual([]);
  console.log(`Runners → Add a host checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
