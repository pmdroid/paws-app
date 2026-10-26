const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const bun = process.argv[2];
  assert(bun && path.isAbsolute(bun));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paws-controls-browser-"));
  const child = spawn(bun, ["--no-env-file", "test/local/execution-controls.ts", "--serve"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { PATH: path.dirname(bun) + ":/usr/bin:/bin", HOME: root, TMPDIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  const errors = [],
    observations = [],
    requests = [];
  try {
    const manifest = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 15000);
      child.once("exit", (code) => reject(new Error("Fixture exited: " + code)));
      child.stderr.on("data", (data) => errors.push(data.toString()));
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
    async function pageFor(identity) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        extraHTTPHeaders: { Cookie: `${manifest.cookie}=${manifest.sessions[identity]}` },
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === manifest.origin
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("request", (request) => {
        if (request.url().includes("/api/execution-controls") && request.method() === "POST")
          requests.push(request.postDataJSON());
      });
      await page.goto(`${manifest.origin}/status/#/runs/${manifest.runId}`);
      return page;
    }
    const page = await pageFor("member");
    await page.getByRole("button", { name: "Pause item", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Confirm stop" }).isVisible(), false);
    await page.getByText("Stop this item", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Confirm stop" }).waitFor();
    const disclosure = await page.locator("#execution-controls details").elementHandle();
    const controlsRefreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/execution-controls" &&
        response.request().method() === "GET",
    );
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/status",
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await (await controlsRefreshed).finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await disclosure.evaluate((node) => node.isConnected && node.open), true);
    assert.equal(requests.length, 0);
    await page.screenshot({ path: path.join(root, "desktop.png"), fullPage: true });
    observations.push({
      name: "Live member controls disclose Stop confirmation and retain its exact DOM node across polling",
      passed: true,
    });
    const observer = await pageFor("observer");
    await observer.locator("#execution-controls").waitFor({ state: "attached" });
    assert.equal(
      await observer.getByRole("button", { name: "Pause item", exact: true }).count(),
      0,
    );
    assert.equal(await observer.locator("#execution-controls").isVisible(), false);
    let failed = false;
    await page.route("**/api/execution-controls", (route) => {
      if (!failed && route.request().method() === "POST") {
        failed = true;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary control outage. Try again." }),
        });
      }
      return route.continue();
    });
    await page.getByRole("button", { name: "Pause item", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Temporary control outage" }).waitFor();
    await page.getByRole("button", { name: "Pause item", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Resume item", exact: true }).waitFor({ timeout: 1500 });
    observations.push({
      name: "A failed mutation remains retryable and keyboard Pause reaches canonical paused state",
      passed: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelector(".side").getBoundingClientRect().right <= 1,
    );
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
    await page.screenshot({ path: path.join(root, "mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Resume item", exact: true }).click();
    await page
      .getByRole("button", { name: "Resume item", exact: true })
      .waitFor({ state: "hidden" });
    if (!(await page.locator("#execution-controls details").evaluate((node) => node.open)))
      await page.getByText("Stop this item", { exact: true }).click();
    await page.getByRole("button", { name: "Confirm stop" }).click();
    await page.locator("#execution-controls").waitFor({ state: "hidden" });
    observations.push({
      name: "Mobile Resume and confirmed selected-item Stop update live authoritative controls without overflow",
      passed: true,
    });
    assert.equal(errors.length, 0, errors.join("\n"));
    assert.deepEqual(
      requests.map((request) => request.action),
      ["pause", "pause", "resume", "stop"],
    );
    fs.writeFileSync(
      path.join(root, "browser-proof.json"),
      JSON.stringify({ observations, requests, errors, fixtureRoot: manifest.root }, null, 2),
    );
    console.log(JSON.stringify({ root, observations, requests, errors }));
  } finally {
    if (browser) await browser.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
