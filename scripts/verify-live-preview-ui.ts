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
  confirmed: true,
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
const reconciliation = await Bun.build({
  entrypoints: [new URL("../src/web/src/client/theme.tsx", import.meta.url).pathname],
  target: "browser",
  minify: true,
});
if (!reconciliation.success) throw new Error("Could not build reconciliation fixture");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/reconciliation.js")
      return new Response(reconciliation.outputs[0], {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/reconciliation")
      return new Response('<div id="fixture"></div>', { headers: { "content-type": "text/html" } });
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
  // Two independent previews must retain their browsing contexts while other forms refresh.
  const reconciliationPage = await browser.newPage();
  await reconciliationPage.goto(`http://127.0.0.1:${server.port}/reconciliation`);
  const markup = (value: string, secondLifetime: number) =>
    `<section><form><textarea id="neighbor">${value}</textarea></form><div data-live-preview="1" data-preview-url="/one"><iframe id="one" src="about:blank"></iframe></div><div data-live-preview="${secondLifetime}" data-preview-url="/two"><iframe id="two" src="about:blank"></iframe></div></section>`;
  const paint = async (html: string) =>
    reconciliationPage.evaluate(async (nextHtml) => {
      const moduleUrl = "/reconciliation.js";
      const { renderMarkup } = await import(moduleUrl);
      renderMarkup(document.getElementById("fixture")!, nextHtml);
    }, html);
  await paint(markup("initial", 2));
  const firstFrame = await reconciliationPage.locator("#one").elementHandle();
  const secondFrame = await reconciliationPage.locator("#two").elementHandle();
  await reconciliationPage.locator("#neighbor").fill("unsaved");
  await paint(markup("updated", 2));
  expect(await firstFrame!.evaluate((node) => node === document.querySelector("#one"))).toBe(true);
  expect(await secondFrame!.evaluate((node) => node === document.querySelector("#two"))).toBe(true);
  await expect(reconciliationPage.locator("#neighbor")).toHaveValue("updated");
  await paint(markup("latest", 3));
  expect(await firstFrame!.evaluate((node) => node === document.querySelector("#one"))).toBe(true);
  expect(await secondFrame!.evaluate((node) => node === document.querySelector("#two"))).toBe(
    false,
  );
  await reconciliationPage.close();
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
      preview.confirmed = false;
      await expect(card.getByRole("button", { name: "Accept", exact: true })).toBeDisabled({
        timeout: 10000,
      });
      expect(loaded).toBe(beforePoll);
      await expect(card).toContainText("Waiting for the runner to reconnect");
      preview.confirmed = true;
      await expect(card.getByRole("button", { name: "Accept", exact: true })).toBeEnabled({
        timeout: 10000,
      });
      expect(loaded).toBe(beforePoll);
      // The next preview can reuse this service URL; its new lifetime must reload the app.
      preview.expiresAt += 1;
      await expect.poll(() => loaded, { timeout: 10000 }).toBe(beforePoll + 1);
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
