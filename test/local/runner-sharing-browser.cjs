const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");
const root = process.argv[2];
if (!root) throw new Error("Provide the runner-sharing-ui evidence directory.");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
if (new URL(fixture.origin).hostname !== "127.0.0.1") throw new Error("Use the loopback fixture.");
const observations = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    for (const identity of ["owner", "member"]) {
      for (const [screen, width, height] of [
        ["desktop", 1440, 1000],
        ["mobile", 390, 844],
      ]) {
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addCookies([{ name: "identity", value: identity, url: fixture.origin }]);
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === fixture.origin
            ? route.continue()
            : route.abort(),
        );
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(fixture.origin);
        const label = "Share this host with members of the same Linear project";
        const index = identity === "owner" ? 0 : 1;
        const card = (at) => page.locator(`[data-runner-card="${fixture.runners[at].id}"]`);
        const consent = card(index).getByRole("checkbox", { name: label });
        await consent.waitFor();
        assert.equal(await consent.isEnabled(), true);
        assert.equal(await page.locator("select").count(), 0);
        const before = await consent.isChecked();
        await consent.focus();
        await page.keyboard.press("Space");
        await page.getByRole("status").filter({ hasText: "Host settings saved." }).waitFor();
        assert.equal(await card(index).getByRole("checkbox", { name: label }).isChecked(), !before);
        await page.getByText("Recent execution", { exact: true }).click();
        const usage = page
          .locator("details")
          .filter({ has: page.locator("summary", { hasText: "Recent execution" }) });
        const rows = await usage.locator("li").count();
        assert.equal(rows, identity === "owner" ? 2 : 1);
        assert.equal(await page.locator("#workspace-runner-policy").count(), 0);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        await page.screenshot({
          path: path.join(root, `${identity}-${screen}.png`),
          fullPage: true,
        });
        observations.push({
          name: `${identity} ${screen} saves owner consent with keyboard and shows authorized usage`,
          passed: true,
          observed: { usageRows: rows, overflow: false },
        });
        assert.equal(
          await card(identity === "owner" ? 1 : 0)
            .getByRole("checkbox", { name: label })
            .isEnabled(),
          false,
        );
        observations.push({
          name: `${identity} ${screen} cannot consent for another host owner`,
          passed: true,
          observed: { disabled: true },
        });
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(root, "observations.json"),
      JSON.stringify(observations, null, 2) + "\n",
    );
    console.log(JSON.stringify({ pass: observations.length, errors: errors.length }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
