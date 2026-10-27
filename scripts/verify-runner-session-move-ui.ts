// Move a running session from the runner card, as an owner and as a member.
// Usage: bun run build:status && bun scripts/verify-runner-session-move-ui.ts <screenshot dir>
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
type Move = { status: "moving" | "waiting" | "stayed"; reason: string | null } | null;
const sessions: {
  runId: string;
  identifier: string;
  title: string;
  phase: string;
  startedAt: number;
  movable: boolean;
  move: Move;
}[] = [
  {
    runId: "run-parser",
    identifier: "PAS-353",
    title: "Store Closeout videos and screenshots and serve them to members",
    phase: "working",
    startedAt: now - 42 * 60_000,
    movable: true,
    move: null,
  },
  {
    runId: "run-cache",
    identifier: "PAS-412",
    title: "Cache the installation token",
    phase: "working",
    startedAt: now - 18 * 60_000,
    movable: false,
    move: { status: "waiting", reason: "Sign in to Claude on another runner." },
  },
  {
    runId: "run-docs",
    identifier: "PAS-418",
    title: "Document the merge lane",
    phase: "fixing",
    startedAt: now - 7 * 60_000,
    movable: true,
    move: {
      status: "stayed",
      reason:
        "The runner found no safe point to stop within 2 minutes, so the session keeps running here.",
    },
  },
  {
    runId: "run-review",
    identifier: "PAS-420",
    title: "Show review rounds",
    phase: "closeout",
    startedAt: now - 3 * 60_000,
    movable: false,
    move: null,
  },
];
const runner = () => ({
  id: "01JRUNNER0000000000000000A",
  name: "ubuntu-arm64",
  ownerUserId: "owner",
  ownerName: "Pascal",
  status: "draining",
  hasRunWork: true,
  metrics: null,
  os: { id: "ubuntu", version: "24.04" },
  version: "0.1.44",
  idle: false,
  slots: { used: sessions.length, total: 4 },
  running: sessions,
  agents: [{ agent: "claude", status: "signed_in", checkedAt: now }],
});
let role = "owner";
const moves: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: role,
        role,
        csrfToken: "fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Acme" }],
        user: { name: "Pascal" },
      });
    if (path === "/api/runners")
      return Response.json({ runners: [runner()], serverVersion: null, agentVersions: [] });
    const move = /^\/api\/runners\/[^/]+\/sessions\/([^/]+)\/move$/.exec(path);
    if (move && request.method === "POST") {
      if (request.headers.get("x-paws-csrf") !== "fixture")
        return Response.json({ error: "CSRF" }, { status: 403 });
      moves.push(move[1]!);
      const session = sessions.find((entry) => entry.runId === move[1]);
      if (session) session.move = { status: "moving", reason: null };
      return Response.json({ ok: true, moving: true }, { status: 202 });
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
const url = `http://127.0.0.1:${server.port}/status/runners/01JRUNNER0000000000000000A`;
const noScroll = () => document.documentElement.scrollWidth <= innerWidth;
try {
  for (const width of [1440, 390]) {
    sessions[0]!.move = null;
    role = "owner";
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(url);
    const slots = page.getByRole("list", { name: "Running issues" });
    await expect(slots.getByText("Sign in to Claude on another runner.")).toBeVisible();
    // The running and the kept session can move; the waiting and the Closeout one cannot.
    await expect(slots.getByRole("button", { name: "Move to another runner" })).toHaveCount(2);
    expect(await page.evaluate(noScroll)).toBe(true);
    await page
      .locator("[data-running-run=run-parser]")
      .getByRole("button", { name: "Move to another runner" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, `session-move-${width}.png`), fullPage: true });
    await page
      .locator("[data-running-run=run-parser]")
      .getByRole("button", { name: "Move to another runner" })
      .click();
    await expect(page.locator("[data-running-run=run-parser]")).toContainText(
      "Moving to another runner",
    );
    await expect(
      page
        .locator("[data-running-run=run-parser]")
        .getByRole("button", { name: "Move to another runner" }),
    ).toHaveCount(0);
    expect(await page.evaluate(noScroll)).toBe(true);
    await page.screenshot({ path: join(directory, `session-moving-${width}.png`), fullPage: true });
    await page.close();

    role = "member";
    const member = await browser.newPage({ viewport: { width, height: 1100 } });
    member.on("pageerror", (error) => errors.push(error.message));
    await member.emulateMedia({ colorScheme: "light" });
    await member.goto(url);
    const listed = member.getByRole("list", { name: "Running issues" });
    await expect(listed.getByText("Cache the installation token")).toBeVisible();
    await expect(listed.getByRole("button")).toHaveCount(0);
    expect(await member.evaluate(noScroll)).toBe(true);
    await member.screenshot({
      path: join(directory, `session-move-member-${width}.png`),
      fullPage: true,
    });
    await member.close();
  }
  expect(moves).toEqual(["run-parser", "run-parser"]);
  expect(errors).toEqual([]);
  console.log(`Session move checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
