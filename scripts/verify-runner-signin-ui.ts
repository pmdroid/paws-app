// Sign in an agent on a runner that is working, and see the account-switch notice first.
// Usage: bun run build:status && bun scripts/verify-runner-signin-ui.ts <screenshot dir>
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
const now = Date.now();
const id = "01JRUNNER0000000000000000A";
const session = (runId: string, identifier: string, title: string) => ({
  runId,
  identifier,
  title,
  phase: "working",
  startedAt: now - 20 * 60_000,
  movable: true,
  move: null,
});
const running = [
  session("run-parser", "PAS-353", "Store Closeout videos and screenshots"),
  session("run-cache", "PAS-412", "Cache the installation token"),
  session("run-codex", "PAS-420", "Retry the GitHub check read"),
];
const runner = {
  id,
  name: "ubuntu-arm64",
  ownerUserId: "owner",
  ownerName: "Pascal",
  status: "active",
  hasRunWork: true,
  metrics: null,
  os: { id: "ubuntu", version: "24.04" },
  version: "0.1.44",
  idle: false,
  slots: { used: 3, total: 4 },
  running,
  agents: [
    { agent: "claude", status: "signed_out", checkedAt: now },
    { agent: "codex", status: "signed_in", checkedAt: now },
    { agent: "grok", status: "signed_out", checkedAt: now },
  ],
};
let claude: Record<string, unknown> | null = null;
const starts: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "owner",
        csrfToken: "fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: [runner], serverVersion: null, agentVersions: [] });
    if (path === `/api/runners/${id}/accounts`)
      return Response.json({
        accounts: [
          { agent: "claude", connected: false, running: 2, session: claude },
          { agent: "codex", connected: true, running: 1, session: null },
          { agent: "grok", connected: false, running: 0, session: null },
        ],
      });
    if (path === `/api/runners/${id}/accounts/claude/login` && request.method === "POST") {
      starts.push("claude");
      claude = {
        id: "00000000-0000-4000-8000-000000000001",
        agent: "claude",
        state: "starting",
        expiresAt: now + 600_000,
        terminal: "",
        authorization: null,
      };
      return Response.json(claude);
    }
    if (path.endsWith("/policy")) return Response.json({ ownerUserId: "owner", sharing: 0 });
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
const noScroll = () => document.documentElement.scrollWidth <= innerWidth;
try {
  for (const width of [1440, 390]) {
    claude = null;
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`http://127.0.0.1:${server.port}/status/runners/${id}`);
    await expect(page.getByText("3 of 4 slots in use")).toBeVisible();
    const signIn = page.getByRole("button", { name: "Sign in to agents" });
    await expect(signIn).toBeEnabled();
    await page.screenshot({ path: join(directory, `runner-busy-${width}.png`), fullPage: true });
    await signIn.click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(
        "Claude is running 2 tasks on this runner. Signing in switches them to the new account from their next request.",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Codex is running 1 task on this runner. Signing in switches it to the new account from its next request.",
      ),
    ).toBeVisible();
    await expect(dialog.getByText(/Grok is running/)).toHaveCount(0);
    expect(await page.evaluate(noScroll)).toBe(true);
    await page.screenshot({ path: join(directory, `signin-notice-${width}.png`) });
    await dialog.getByRole("button", { name: "Sign in to Claude" }).click();
    await expect(dialog.getByText("Starting sign-in…")).toBeVisible();
    await expect(dialog.getByText(/Claude is running/)).toHaveCount(0);
    await page.screenshot({ path: join(directory, `signin-started-${width}.png`) });
    await page.close();
  }
  expect(starts).toEqual(["claude", "claude"]);
  expect(errors).toEqual([]);
  console.log(`Sign-in checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
