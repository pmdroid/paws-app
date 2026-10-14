const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = process.argv[2];
const { origin, token } = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(new URL(origin).hostname, "127.0.0.1");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const [screen, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        extraHTTPHeaders: { Cookie: `__Host-paws-session=${token}` },
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${origin}/status/#/settings/decisions`);
      await page.getByRole("heading", { name: "Saved decisions" }).waitFor();
      if (screen === "desktop") {
        await page.getByText("Save an answer as a decision", { exact: true }).click();
        await page.getByLabel("Confirmed answer").selectOption({ index: 1 });
        assert.equal(
          await page.getByLabel("Decision", { exact: true }).inputValue(),
          "Use cursor pagination and the existing response format.",
        );
        await page.getByLabel("Tags, separated by commas").fill("pagination, api");
        await page.getByRole("button", { name: "Save decision", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.getByText("0 accepted / 0 suggestions · Revision 1", { exact: true }).waitFor();
        await page.getByText("Correct or retire decision", { exact: true }).click();
        await page
          .getByLabel("Decision", { exact: true })
          .fill("Use cursor pagination with the existing response envelope.");
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await page.getByText("0 accepted / 0 suggestions · Revision 2", { exact: true }).waitFor();
        observations.push(
          "Keyboard saving and correction persist through the production authenticated API",
        );
      }
      await page.getByLabel("Search decisions", { exact: true }).fill("pagination");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page
        .locator("article > p")
        .filter({ hasText: "Use cursor pagination with the existing response envelope." })
        .waitFor();
      assert.match(
        await page.getByRole("link", { name: "Source answer in Linear" }).getAttribute("href"),
        /^https:\/\/linear.app\/issue\//,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: path.join(root, `${screen}.png`), fullPage: true });
      if (screen === "mobile") {
        await page.getByText("Correct or retire decision", { exact: true }).click();
        await page.getByLabel("Retire this decision", { exact: true }).check();
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await page.getByText("Retired", { exact: true }).waitFor();
        await page.reload();
        await page.getByText("Retired", { exact: true }).waitFor();
        assert.equal(
          await page.getByText("Correct or retire decision", { exact: true }).count(),
          0,
        );
        observations.push("Retirement survives reload and removes correction actions");
      }
      assert.deepEqual(errors, []);
      observations.push(`${screen} search, citation and layout pass without browser exceptions`);
      await context.close();
    }
    fs.writeFileSync(
      path.join(root, "browser-observations.json"),
      JSON.stringify(observations, null, 2),
    );
    console.log(observations);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
