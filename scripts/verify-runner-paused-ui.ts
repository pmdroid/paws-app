// Capture the first activation step on a newly enrolled runner.
// Usage: bun run build:status && bun scripts/verify-runner-paused-ui.ts <screenshot dir>
import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { onboardingPage } from "../src/workspace";
import { demoStatus, handleStatusRequest } from "../src/web";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });
const snapshot = demoStatus();
snapshot.source = "live";
const runner = {
  id: "01JRUNNER0000000000000000A",
  name: "pascal-paws",
  ownerUserId: "member",
  ownerName: "Pascal",
  status: "paused",
  hasRunWork: false,
  metrics: null,
  os: { id: "ubuntu", version: "24.04" },
  version: "1.0.0",
  idle: true,
  slots: { used: 0, total: 2 },
  running: [],
  agents: ["claude", "codex", "grok"].map((agent) => ({
    agent,
    status: "signed_out",
    checkedAt: Date.now(),
  })),
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/onboard/paused")
      return onboardingPage({
        identifier: "PAS-722",
        issueUrl: null,
        teamName: "Pascal",
        member: { name: "Pascal", email: null },
        memberOfTeam: true,
        observer: false,
        readiness: {
          runner: { state: "paused", id: runner.id, name: runner.name },
          agents: { claude: "waiting", codex: "waiting" },
          memberVm: true,
        },
        github: null,
        csrfToken: "fixture",
      });
    if (path === "/api/auth/session")
      return Response.json({
        userId: "member",
        role: "member",
        csrfToken: "fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: [runner], serverVersion: null, agentVersions: [] });
    if (path.endsWith("/policy")) return Response.json({ ownerUserId: "member", sharing: 0 });
    if (path === "/api/runners/vm") return Response.json({ available: false, vm: null });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "fixture",
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
    await page.goto(`http://127.0.0.1:${server.port}/status/runners/${runner.id}`);
    await expect(
      page.getByText("Sign in the coding agents this runner should use, then turn it on."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign in to agents" })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: join(directory, `runner-paused-${width}.png`), fullPage: true });
    await page.goto(`http://127.0.0.1:${server.port}/onboard/paused`);
    await expect(page.getByText("Ready (paused)", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Runners" })).toHaveAttribute(
      "href",
      `/status/runners/${runner.id}`,
    );
    await page.screenshot({
      path: join(directory, `onboarding-paused-${width}.png`),
      fullPage: true,
    });
    await page.close();
  }
  expect(errors).toEqual([]);
  console.log(`Paused runner checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
