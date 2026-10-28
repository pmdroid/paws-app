import { statusFixture } from "../../src/web/test/fixtures";
// Captures the Runners list with the coding agent version catalog at desktop and 390 px, light and dark.
// Usage: bun run build:status && bun --no-env-file test/local/agent-catalog-browser.ts <evidence-directory>
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { handleStatusRequest } from "../../src/web";

const directory = resolve(process.argv[2] ?? "agent-catalog-evidence");
await mkdir(directory, { recursive: true });

const snapshot = statusFixture();
snapshot.source = "live";
const HOUR = 3_600_000;

function body() {
  const now = Date.now();
  return {
    runners: [
      {
        id: "01JRUNNER0000000000000CALM",
        name: "build-box",
        ownerUserId: "owner",
        status: "active",
        metrics: null,
        os: { id: "ubuntu", version: "24.04" },
        version: "1.4.0",
        idle: true,
        slots: { used: 0, total: 3 },
      },
    ],
    serverVersion: "1.4.0",
    workspaceReady: true,
    agentVersions: [
      {
        agent: "claude",
        offered: "0.88.0",
        refused: [
          {
            version: "0.89.0",
            reason:
              "The integrity of @agentclientprotocol/claude-agent-acp@0.89.0 changed after Paws first saw it on 2026-10-22T09:14:03.000Z.",
          },
        ],
        checkedAt: now - 2 * HOUR,
      },
      { agent: "codex", offered: "2.1.1", refused: [], checkedAt: now - 2 * HOUR },
      { agent: "grok", offered: null, refused: [], checkedAt: now - 2 * HOUR },
    ],
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "admin",
        csrfToken: "agent-catalog-fixture",
        workspaceId: "workspace",
        workspaces: [{ id: "workspace", name: "Paws" }],
        user: { name: "Owner" },
      });
    if (path === "/api/runners") return Response.json(body());
    if (/^\/api\/runners\/[^/]+\/policy$/.test(path))
      return Response.json({ ownerUserId: "owner", sharing: 1 });
    return (
      (await handleStatusRequest(request, {
        provider: { snapshot: () => snapshot },
        csrfToken: "agent-catalog-fixture",
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
  for (const width of [1280, 390])
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.emulateMedia({ colorScheme: scheme });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/status/runners`);
      await page.locator("#agent-catalog-heading").waitFor();
      await page.screenshot({
        path: join(directory, `agent-catalog-${width}-${scheme}.png`),
        fullPage: true,
      });
      await page.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(directory);
