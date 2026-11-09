import { chromium, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleStatusRequest } from "../src/dashboard";
import { fixtureProvider, fullStatusFixture } from "../src/dashboard/test/fixtures";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a directory for the screenshots");
mkdirSync(directory, { recursive: true });

const warning = "goldbox can't take pmdroid/paws-app (not in its allowed repositories)";
const reason =
  "No runner can take pmdroid/paws-app: goldbox: repository not allowed in the runner's host config; agentbox: no free capacity";
const runner = {
  id: "01JRUNNER0000000000000000A",
  name: "goldbox",
  ownerUserId: "owner",
  status: "active",
  hostWarnings: [warning],
};
const snapshot = fullStatusFixture();
snapshot.source = "live";
const item = snapshot.items.find((entry) => entry.state === "queued") ?? snapshot.items[0]!;
item.state = "queued";
item.held = { reason: "slot", blockers: [reason] };

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/session")
      return Response.json({
        userId: "owner",
        role: "admin",
        workspaceId: "w",
        workspaces: [{ id: "w", name: "Fixture" }],
        user: { name: "Owner", email: null },
      });
    if (path === "/api/workspaces/repositories") return Response.json({ repositories: [] });
    if (path === "/api/runners/usage") return Response.json({ usage: [] });
    if (path === "/api/runners/vm") return Response.json({ vms: [] });
    if (path === "/api/runners/vm/pools") return Response.json({ pools: [] });
    if (path === "/api/runners")
      return Response.json({
        setupRequired: false,
        workspaceReady: true,
        runners: [runner],
        serverVersion: null,
        agentVersions: [],
      });
    if (path.endsWith("/policy")) return Response.json({ ownerUserId: "owner", sharing: 0 });
    return (
      (await handleStatusRequest(request, {
        provider: fixtureProvider(snapshot),
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
try {
  for (const [name, path, text] of [
    ["runners", "/dashboard/runners", warning],
    ["issue", `/dashboard/issues/${item.id}`, reason],
  ] as const) {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`http://127.0.0.1:${server.port}${path}`);
      const shown = page.getByText(text, { exact: false }).first();
      await expect(shown).toBeVisible();
      await shown.scrollIntoViewIfNeeded();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) throw new Error(`${name} at ${width} px overflows by ${overflow} px`);
      await page.screenshot({ path: join(directory, `runner-host-warning-${name}-${width}.png`) });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
