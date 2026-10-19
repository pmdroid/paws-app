const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = process.argv[2],
    bun = process.argv[3];
  const child = spawn(bun, ["--no-env-file", "test/local/onboarding.ts", root], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let browser;
  try {
    const manifest = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Fixture timeout")), 10000);
      child.once("exit", (code) => reject(Error(`Fixture exited ${code}`)));
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.origin) {
            clearTimeout(timer);
            resolve(value);
          }
        } catch {}
      });
    });
    browser = await chromium.launch({ headless: true });
    const observations = [],
      errors = [];
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== manifest.origin) return route.abort();
        if (url.pathname === "/auth/linear") {
          const response = await route.fetch({ maxRedirects: 0 });
          const provider = new URL(response.headers().location);
          const callback = new URL("/auth/linear/callback", manifest.origin);
          callback.searchParams.set("state", provider.searchParams.get("state"));
          callback.searchParams.set("code", "member");
          return route.fulfill({
            response,
            headers: { ...response.headers(), location: callback.href },
          });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      if (name === "desktop") {
        await page.goto(manifest.origin + manifest.assignment);
        await page.waitForURL(manifest.origin + manifest.page);
      } else {
        const cookies = JSON.parse(fs.readFileSync(path.join(root, "session.json")));
        await context.addCookies(cookies);
        await page.goto(manifest.origin + manifest.page);
      }
      await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
      assert((await page.locator("body").innerText()).includes("PAS-339"));
      assert((await page.locator("body").innerText()).includes("Not checked"));
      assert((await page.locator("body").innerText()).includes("Not linked"));
      assert.equal(await page.getByRole("button", { name: "Connect GitHub" }).count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, `${name}-light.png`), fullPage: true });
      await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
      await page.screenshot({ path: path.join(root, `${name}-dark.png`), fullPage: true });
      await page.reload();
      await page.getByRole("heading", { name: "Your VM" }).waitFor();
      await context.clearCookies();
      await page.reload();
      const signIn = page.getByRole("link", { name: "Sign in with Linear" });
      await signIn.waitFor();
      assert(!(await page.locator("body").innerText()).includes("PAS-339"));
      await signIn.click();
      await page.waitForURL(manifest.origin + manifest.page);
      await page.getByRole("heading", { name: "Your VM" }).waitFor();
      if (name === "desktop")
        fs.writeFileSync(path.join(root, "session.json"), JSON.stringify(await context.cookies()));
      await context.route("**/api/workspaces/onboarding?*", (route) =>
        route.fulfill({ status: 503, body: "{}" }),
      );
      await page.reload();
      await page.getByRole("button", { name: "Try again" }).waitFor();
      assert(!(await page.locator("body").innerText()).includes("PAS-339"));
      await context.unroute("**/api/workspaces/onboarding?*");
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
      observations.push({
        name,
        passed: true,
        realOAuthRedirect: name === "desktop",
        truthfulSteps: true,
        reloadPersists: true,
        noOverflow: true,
        outageClearsIssue: true,
        keyboardRetry: true,
        signedOutShellAndSafeReturn: true,
      });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
    fs.unlinkSync(path.join(root, "session.json"));
    console.log(JSON.stringify(observations));
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await exited;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
