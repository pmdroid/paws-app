// Move running work off a draining runner until it shows Drained, as an owner and an observer.
// Usage: bun run build:status && bun scripts/verify-runner-drain-ui.ts <screenshot dir>
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
type Session = {
  runId: string;
  identifier: string;
  title: string;
  phase: string;
  startedAt: number;
  movable: boolean;
  move: Move;
};
const fresh = (): Session[] => [
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
    phase: "fixing",
    startedAt: now - 18 * 60_000,
    movable: true,
    move: null,
  },
];
let sessions = fresh();
/** What the runner backend does once asked: both move, or both wait with a reason. */
let outcome: "moving" | "waiting" = "moving";
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
  idle: sessions.length === 0,
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
    if (/^\/api\/runners\/[^/]+\/sessions\/move$/.test(path) && request.method === "POST") {
      if (request.headers.get("x-paws-csrf") !== "fixture")
        return Response.json({ error: "CSRF" }, { status: 403 });
      if (role !== "owner") return Response.json({ error: "Forbidden" }, { status: 403 });
      moves.push(path);
      for (const session of sessions)
        session.move =
          outcome === "moving"
            ? { status: "moving", reason: null }
            : { status: "waiting", reason: "Sign in to Claude on another runner." };
      if (outcome === "waiting") for (const session of sessions) session.movable = false;
      return Response.json({ ok: true, moving: sessions.length }, { status: 202 });
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
    const open = async () => {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(url);
      return page;
    };
    const shot = async (page: Awaited<ReturnType<typeof open>>, name: string) => {
      expect(await page.evaluate(noScroll)).toBe(true);
      await page.screenshot({ path: join(directory, `${name}-${width}.png`), fullPage: true });
    };
    const moveAll = (page: Awaited<ReturnType<typeof open>>) =>
      page.getByRole("button", { name: "Move running work" });

    // Owner: two sessions on the draining runner, then Move running work, then Drained.
    role = "owner";
    sessions = fresh();
    outcome = "moving";
    const page = await open();
    await expect(page.getByText("2 sessions still run here.")).toBeVisible();
    await expect(moveAll(page)).toBeVisible();
    await shot(page, "drain-before");
    await moveAll(page).click();
    await expect(page.getByText("Moving 2 sessions")).toBeVisible();
    await expect(moveAll(page)).toHaveCount(0);
    await shot(page, "drain-moving");
    // Both landed on another runner.
    sessions = [];
    await page.reload();
    await expect(page.locator(".runner-drain").getByText("Drained")).toBeVisible();
    await expect(page.getByText("It is safe to remove this runner.")).toBeVisible();
    await shot(page, "drain-drained");
    await page.close();

    // No eligible runner: both wait with the reason, and the card is not Drained.
    sessions = fresh();
    outcome = "waiting";
    const waiting = await open();
    await moveAll(waiting).click();
    await expect(waiting.getByText("2 sessions waiting for another runner")).toBeVisible();
    await expect(waiting.getByText("Sign in to Claude on another runner.")).toHaveCount(2);
    await expect(waiting.getByText("Drained")).toHaveCount(0);
    await shot(waiting, "drain-waiting");
    await waiting.close();

    // Observer: the list and progress, no button.
    role = "observer";
    sessions = fresh();
    const observer = await open();
    await expect(observer.getByText("2 sessions still run here.")).toBeVisible();
    await expect(moveAll(observer)).toHaveCount(0);
    await expect(
      observer.getByRole("list", { name: "Running issues" }).getByRole("button"),
    ).toHaveCount(0);
    await shot(observer, "drain-observer");
    await observer.close();
  }
  expect(moves).toHaveLength(4);
  expect(errors).toEqual([]);
  console.log(`Drain checks passed. Screenshots in ${directory}`);
} finally {
  await browser.close();
  server.stop(true);
}
