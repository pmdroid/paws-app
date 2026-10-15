const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("@playwright/test");
const bun = process.argv[2];
const root = process.argv[3];
assert(bun && path.isAbsolute(bun) && root && path.isAbsolute(root));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
assert(!fs.existsSync(path.join(root, "workspace-ui.json")), "Use a fresh proof directory");
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const log = fs.openSync(path.join(root, "fixture.log"), "w", 0o600);
const child = spawn(bun, ["--no-env-file", path.join(__dirname, "settings-ui.ts")], {
  cwd: path.join(__dirname, "../.."),
  env: {
    PATH: path.dirname(bun) + ":/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    KYOTOAGENT_ROOT: path.join(home, ".kyotoagent"),
    PAWS_HOME: path.join(home, ".paws"),
    PAWS_VERIFY_ROOT: root,
  },
  stdio: ["ignore", log, log],
});
const observations = [],
  errors = [];
let browser;
(async () => {
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(root, "workspace-ui.json"))) {
      assert(Date.now() < deadline && child.exitCode === null, "Fixture did not start");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const fixture = JSON.parse(fs.readFileSync(path.join(root, "workspace-ui.json"), "utf8"));
    let catalogs = [
      {
        agent: "claude",
        updatedAt: 1,
        efforts: [{ id: "high", name: "High" }],
        models: [
          { id: "sonnet", name: "Sonnet", efforts: [{ id: "high", name: "High" }] },
          {
            id: "opus",
            name: "Opus",
            efforts: [
              { id: "low", name: "Low" },
              { id: "max", name: "Max" },
            ],
          },
        ],
      },
      {
        agent: "codex",
        updatedAt: 1,
        efforts: [{ id: "medium", name: "Medium" }],
        models: [
          { id: "model-a", name: "Model A", efforts: [{ id: "medium", name: "Medium" }] },
          { id: "model-b", name: "Model B", efforts: [{ id: "xhigh", name: "Extra high" }] },
        ],
      },
    ];
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let hold = true;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.origin) return route.abort();
      if (url.pathname === "/api/runners/models") {
        if (hold) await held;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ catalogs }),
        });
      }
      if (url.pathname !== "/auth/linear") return route.continue();
      const response = await route.fetch({ maxRedirects: 0 });
      const provider = new URL(response.headers().location);
      const callback = new URL(provider.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", provider.searchParams.get("state"));
      callback.searchParams.set("code", "owner");
      return route.fulfill({
        response,
        headers: { ...response.headers(), location: callback.href },
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.clock.install();
    await page.goto(fixture.origin + "/status/");
    await page.getByText("Set up your first workspace", { exact: true }).click();
    await page.locator("input[name=bootstrap]").fill(fixture.bootstrap);
    await page.getByRole("button", { name: "Connect workspace" }).click();
    await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
    await page.goto(fixture.origin + "/status/#/settings/agents");
    await page.getByRole("button", { name: "Save settings", exact: true }).waitFor();
    assert.equal(await page.locator("#defaults-implementer-model").isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "Save settings", exact: true }).isEnabled(),
      true,
    );
    observations.push({ settingsAvailableWhileChoicesPending: true });
    hold = false;
    release();
    await page.waitForFunction(
      () => !document.querySelector("#defaults-implementer-model").disabled,
    );
    await page.locator("#defaults-implementer-model").selectOption("sonnet");
    await page.locator("#defaults-implementer-effort").selectOption("high");
    await page.locator("#defaults-reviewer-model").selectOption("model-b");
    assert.deepEqual(
      await page
        .locator("#defaults-reviewer-effort option")
        .evaluateAll((options) => options.map((option) => option.value)),
      ["", "xhigh"],
    );
    await page.locator("#defaults-reviewer-effort").selectOption("xhigh");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText("Agent settings saved. New work will use these profiles.").waitFor();
    const saved = await page.evaluate(
      async () => await (await fetch("/api/settings/agents")).json(),
    );
    assert.deepEqual(saved.defaults.implementer, {
      agent: "claude",
      model: "sonnet",
      effort: "high",
    });
    assert.deepEqual(saved.defaults.reviewer, {
      agent: "codex",
      model: "model-b",
      effort: "xhigh",
    });
    observations.push({ savedModelAndEffortDefaults: true });
    await page.locator("#defaults-implementer-model").selectOption("opus");
    assert.equal(await page.locator("#defaults-implementer-effort").inputValue(), "");
    assert.deepEqual(
      await page
        .locator("#defaults-implementer-effort option")
        .evaluateAll((options) => options.map((option) => option.value)),
      ["", "low", "max"],
    );
    await page.locator("#defaults-implementer-effort").selectOption("max");
    await page.locator("#settings-repo").fill("acme/unsaved");
    catalogs[0].models[0].name = "Sonnet refreshed";
    catalogs[0].updatedAt = 2;
    await page.clock.fastForward(10001);
    await page.waitForFunction(() =>
      document
        .querySelector("#defaults-implementer-model")
        .textContent.includes("Sonnet refreshed"),
    );
    assert.equal(await page.locator("#settings-repo").inputValue(), "acme/unsaved");
    assert.equal(await page.locator("#defaults-implementer-model").inputValue(), "opus");
    assert.equal(await page.locator("#defaults-implementer-effort").inputValue(), "max");
    observations.push({ modelChangeResetsEffortAndBackgroundRefreshPreservesDraft: true });
    await page.locator("#defaults-implementer-agent").selectOption("codex");
    assert.equal(await page.locator("#defaults-implementer-model").inputValue(), "");
    assert.equal(await page.locator("#defaults-implementer-effort").inputValue(), "");
    assert.equal(
      await page.locator("#defaults-implementer-model option[value=model-b]").count(),
      1,
    );
    observations.push({ agentChangeResetsModelAndEffort: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: path.join(root, "agent-models-" + width + ".png"),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(root, "observations.json"),
      JSON.stringify(
        { observations, errors, catalogsScripted: true, settingsSavedViaProductionHttp: true },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ root, observations }, null, 2));
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000).unref();
    });
    fs.closeSync(log);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
