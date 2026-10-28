/** Render the live-preview review with a fixture product at desktop and phone sizes. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { fullStatusFixture, fixtureProvider } from "../src/web/test/fixtures";
import { handleStatusRequest } from "../src/web";

const directory = process.argv[2] ?? "out/live-preview";
mkdirSync(directory, { recursive: true });
const snapshot = fullStatusFixture();
snapshot.source = "live";
const item = snapshot.items.find((entry) => entry.id === "ENG-103")!;
const run = snapshot.runs.find((entry) => entry.itemId === item.id)!;
item.state = "awaiting_input";
item.owner = "Jonas Berg";
item.visualReviews = [];
run.state = "awaiting_input";
const preview = {
  url: "https://paws-preview-1.test-tail.ts.net/settings",
  checklist: [
    "Add a fixture teammate and confirm they appear in the list.",
    "Change the display name, save, and reload.",
    "Try the layout at phone width.",
  ],
  frameable: true,
  expiresAt: Date.now() + 3600000,
};
snapshot.questions = [
  {
    id: "preview-question",
    itemId: item.id,
    runId: run.id,
    title: "Try the product before the pull request opens",
    body: "Review the live preview",
    context: "",
    kind: "decision",
    urgency: "blocking",
    options: [],
    recommendedOption: null,
    askedAt: new Date().toISOString(),
    claimedBy: null,
    links: [],
    linkAsk: {
      kind: "preview",
      head: "a".repeat(40),
      title: "Try the product before the pull request opens",
      detail: "",
      link: `https://paws.example/status/issues/${item.id}#live-preview`,
      preview,
    },
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
        provider: fixtureProvider(snapshot),
        csrfToken: "preview-fixture",
      })) ?? new Response("Not found", { status: 404 })
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
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 2600 } });
      await page.addInitScript(
        (appearance) => localStorage.setItem("paws.appearance", appearance),
        theme,
      );
      let loaded = 0;
      await page.route("https://paws-preview-1.test-tail.ts.net/**", async (route) => {
        loaded++;
        await route.fulfill({
          contentType: "text/html",
          body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px system-ui;padding:24px;color:#16211d;background:#f5f8f6}input,button{font:inherit;padding:10px;margin:6px 0;border:1px solid #51695f;border-radius:4px}label{display:block}button{background:#245f46;color:white;cursor:pointer}</style></head><body><h1>Workspace settings</h1><p>Fixture product for preview review</p><label>Display name<br><input value="Example workspace"></label><button onclick="document.querySelector('#saved').textContent='Changes saved'">Save changes</button><p id="saved" role="status"></p></body></html>`,
        });
      });
      await page.goto(`http://127.0.0.1:${server.port}/status/issues/${item.id}#live-preview`);
      const card = page.locator("#live-preview");
      await expect(card.getByRole("heading", { name: "Live preview", exact: true })).toBeVisible();
      const frame = page.frameLocator('iframe[title="Live product preview"]');
      await frame.getByRole("button", { name: "Save changes" }).click();
      await expect(frame.getByRole("status")).toHaveText("Changes saved");
      await card.getByRole("button", { name: "Phone", exact: true }).click();
      await expect(page.locator("iframe")).toHaveCSS("width", "390px");
      await card.getByRole("button", { name: "Reload", exact: true }).click();
      await expect(frame.getByRole("status")).toHaveText("");
      await card.getByRole("button", { name: "Desktop", exact: true }).click();
      const beforePoll = loaded;
      await page.waitForTimeout(5500);
      expect(loaded).toBe(beforePoll);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: join(directory, `${theme}-${width}.png`), fullPage: true });
      preview.frameable = false;
      await page.reload();
      await expect(page.locator("#live-preview")).toContainText("does not allow framing");
      await expect(page.locator("iframe")).toHaveCount(0);
      preview.frameable = true;
      await page.close();
    }
} finally {
  await browser.close();
  server.stop(true);
}
