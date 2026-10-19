const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const bun = process.argv[2];
  assert(bun && path.isAbsolute(bun));
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "paws-self-pairing-browser-")),
  );
  const home = path.join(root, "home");
  const kyoto = path.join(home, ".kyotoagent");
  fs.mkdirSync(kyoto, { recursive: true });
  assert.equal(fs.realpathSync(home), home);
  assert.equal(fs.realpathSync(kyoto), kyoto);
  const child = spawn(bun, ["--no-env-file", "test/fixtures/runner-dashboard-instance.ts"], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      PATH: path.dirname(bun) + ":/usr/bin:/bin",
      HOME: home,
      KYOTOAGENT_ROOT: kyoto,
      PAWS_VERIFY_ROOT: root,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const logs = [];
  child.stderr.on("data", (data) => logs.push(data.toString()));
  const manifest = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs.join("\n"))), 20000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      logs.push(line);
      try {
        const value = JSON.parse(line);
        if (value.origin) {
          clearTimeout(timer);
          resolve(value);
        }
      } catch {}
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited ${code}: ${logs.join("\n")}`));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const observations = [];
  let browser;
  try {
    const fixture = await manifest;
    browser = await chromium.launch({ headless: true });
    for (const [screen, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height },
      });
      await context.addCookies([
        {
          name: fixture.cookie,
          value: fixture.sessions.member,
          url: fixture.origin,
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(fixture.origin + "/status/runners");
      const pair = page.getByRole("button", { name: "Pair a host", exact: true });
      await pair.waitFor();
      const enrollment = await context.request.post(fixture.origin + "/api/runner-pairings", {
        data: { name: `${screen} member VM`, csr: fixture.client.csr },
      });
      assert.equal(enrollment.status(), 200);
      const pending = await enrollment.json();
      await pair.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "Pair a host" }).waitFor();
      await page.getByLabel("Pairing code from the host").fill(pending.code);
      await page.getByLabel("Pairing code from the host").press("Enter");
      await page.getByText(pending.requestFingerprint, { exact: true }).waitFor();
      const refreshed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/runners" &&
          response.request().method() === "GET",
      );
      await page.getByRole("button", { name: "Approve runner", exact: true }).click();
      await refreshed;
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const identity = await (
        await context.request.get(fixture.origin + "/api/auth/session")
      ).json();
      const listed = await (await context.request.get(fixture.origin + "/api/runners")).json();
      const runner = listed.runners.find((entry) => entry.name === `${screen} member VM`);
      assert(runner);
      assert.equal(runner.ownerUserId, identity.userId);
      const claim = await context.request.post(fixture.origin + "/api/runner-pairings", {
        data: { id: pending.id, claim: pending.claim },
      });
      assert.equal(claim.status(), 200);
      assert((await claim.json()).certificate);
      await page.screenshot({ path: path.join(root, `${screen}-paired.png`), fullPage: true });
      await page.goto(`${fixture.origin}/status/runners/${runner.id}`);
      await page.getByRole("heading", { name: `${screen} member VM`, exact: true }).waitFor();
      assert.equal(await page.locator("[data-runner-status]").count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await context.route("**/api/auth/session", (route) =>
        route.fulfill({ json: { ...identity, role: "observer" } }),
      );
      await page.goto(fixture.origin + "/status/runners");
      await page.getByText(`${screen} member VM`, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Pair a host", exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      observations.push({
        name: `${screen} member pairs through production API and owns VM; host controls hidden; scripted observer cannot pair`,
        passed: true,
        runnerId: runner.id,
      });
      await context.close();
    }
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify({ root, observations }));
  } finally {
    await browser?.close();
    child.stdin.end("stop\n");
    await exited;
    fs.writeFileSync(path.join(root, "fixture.log"), logs.join("\n"));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
