const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");
const root = process.argv[2];
const { origin, pid } = JSON.parse(fs.readFileSync(path.join(root, "instance.json"), "utf8"));
const resume = process.argv.includes("--resume");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  const errors = [];
  try {
    if (!resume)
      for (const [name, width, height] of [
        ["desktop", 1440, 1000],
        ["mobile", 390, 844],
      ]) {
        for (const colorScheme of ["light", "dark"]) {
          const context = await browser.newContext({
            viewport: { width, height },
            colorScheme,
            ignoreHTTPSErrors: true,
          });
          await context.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.goto(origin + "/status/");
          await page.getByRole("heading", { name: "Connect your workspace" }).waitFor();
          assert.equal(await page.getByText("Setup code from the Paws operator").count(), 0);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({
            path: path.join(root, `${name}-${colorScheme}.png`),
            fullPage: true,
          });
          observations.push({ name: `${name} ${colorScheme} fresh onboarding`, passed: true });
          await context.close();
        }
      }
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(resume ? { storageState: path.join(root, "browser-state.json") } : {}),
    });
    const actors = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/auth/linear")) return route.continue();
      const response = await route.fetch({ maxRedirects: 0 });
      const target = new URL(response.headers().location ?? origin, origin);
      if (target.origin !== "https://linear.app") return route.fulfill({ response });
      assert.equal(target.pathname, "/oauth/authorize");
      const actor = target.searchParams.get("actor");
      actors.push(actor);
      const callback = new URL(target.searchParams.get("redirect_uri"));
      assert.equal(callback.origin, origin);
      callback.searchParams.set("state", target.searchParams.get("state"));
      callback.searchParams.set("code", actor === "user" ? "user-code" : "app-code");
      await route.fulfill({
        response,
        status: 200,
        contentType: "text/html",
        body: `<script>location.href=${JSON.stringify(callback.href)}</script>`,
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(origin + (resume ? "/status/settings/integrations" : "/status/"));
    if (!resume) {
      await page.getByRole("link", { name: "Sign in with Linear" }).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL("**/status/settings/integrations?connecting=1");
    }
    await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session");
      return { status: response.status, body: await response.json() };
    });
    assert.equal(session.status, 200);
    assert.equal(session.body.role, "owner");
    assert.deepEqual(actors, resume ? [] : ["user", "app"]);
    assert.equal(errors.length, 0, errors.join("\n"));
    await page.screenshot({ path: path.join(root, "connected-integrations.png"), fullPage: true });
    observations.push({
      name: resume
        ? "workspace session and authorization survive process restart"
        : "browser authorization starts the connected service and continues to GitHub",
      passed: true,
    });
    if (!resume) {
      process.kill(pid, "SIGUSR1");
      await page.waitForFunction(async () => (await fetch("/api/auth/session")).status === 401);
      await page.reload();
      await page.getByRole("heading", { name: "Reconnect Linear" }).waitFor();
      await page.getByRole("link", { name: "Sign in with Linear" }).click();
      await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
      const reconnected = await page.evaluate(async () =>
        (await fetch("/api/auth/session")).json(),
      );
      assert.equal(reconnected.role, "owner");
      assert.equal(reconnected.workspaceId, session.body.workspaceId);
      assert.deepEqual(actors, ["user", "app", "user", "app"]);
      observations.push({
        name: "revoked Linear access reconnects through the browser without changing ownership",
        passed: true,
      });
    }
    await context.storageState({ path: path.join(root, "browser-state.json") });
    fs.chmodSync(path.join(root, "browser-state.json"), 0o600);
    fs.writeFileSync(
      path.join(root, resume ? "restart-observations.json" : "observations.json"),
      JSON.stringify(observations, null, 2),
    );
    console.log(JSON.stringify(observations));
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
