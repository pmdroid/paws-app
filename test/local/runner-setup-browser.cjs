const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");
const root = process.argv[2];
if (!root) throw new Error("Provide the runner-setup-ui evidence directory");
const { origin } = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(new URL(origin).hostname, "127.0.0.1");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const [screen, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      let configured = false;
      const requests = [];
      const errors = [];
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        const endpoint = url.pathname;
        requests.push(endpoint);
        if (configured) {
          const values = {
            "/api/runners": { runners: [] },
            "/api/auth/session": { userId: "owner", role: "owner", authenticatedAt: Date.now() },
            "/api/runners/policy": { fallbackAllowed: false, personalOrganizationHost: false },
            "/api/runners/usage": { usage: [] },
          };
          if (Object.hasOwn(values, endpoint)) return route.fulfill({ json: values[endpoint] });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/status/#/runners`);
      await page.getByRole("heading", { name: "Set up remote runners" }).waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(requests.filter((p) => p === "/api/auth/session").length, 1);
      assert.equal(requests.includes("/api/runners/policy"), false);
      assert.equal(requests.includes("/api/runners/usage"), false);
      assert.equal(
        await page.getByText("bun run paws runner-authority init", { exact: true }).count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("link", { name: "Open the workspace setup guide" })
          .getAttribute("href"),
        "https://github.com/pmdroid/paws-app/blob/main/docs/workspace-access.md",
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: path.join(root, `${screen}-setup.png`), fullPage: true });
      const previous = requests.filter((p) => p === "/api/runners").length;
      await page.getByRole("button", { name: "Check setup" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-runners-refresh]")?.disabled);
      assert(requests.filter((p) => p === "/api/runners").length > previous);
      observations.push({
        name: `${screen} local HTTP shows real setup guidance without disabled API requests`,
        passed: true,
      });
      configured = true;
      await page.getByRole("button", { name: "Check setup" }).click();
      await page.getByRole("heading", { name: "Pair a host" }).waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "Pairing code from the host" }).count(),
        1,
      );
      assert.equal(
        await page.getByText("Workspace execution permission", { exact: true }).count(),
        1,
      );
      assert.equal(await page.getByRole("heading", { name: "Set up remote runners" }).count(), 0);
      assert.deepEqual(errors, []);
      observations.push({
        name: `${screen} refresh switches to owner pairing and settings after configuration`,
        passed: true,
        observed: { configuredResponses: "scripted" },
      });
      await context.close();
    }
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify({ passed: observations.length }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
