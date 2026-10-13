const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");

const [origin, evidenceRoot, workspaceRoot] = process.argv.slice(2);
if (!origin || !evidenceRoot || new URL(origin).hostname !== "127.0.0.1")
  throw new Error("Use the loopback URL and evidence directory from verify:local serve.");
const observations = [];
const errors = [];
const observe = (name, detail) => observations.push({ name, detail });

async function inspect(page, name) {
  for (const [width, height, size] of [
    [1440, 1000, "desktop"],
    [390, 844, "mobile"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(
      () => innerWidth > 900 || document.querySelector("#side").getBoundingClientRect().right <= 0,
    );
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(overflow.scroll <= overflow.width, JSON.stringify(overflow));
    await page.screenshot({ path: path.join(evidenceRoot, `${name}-${size}.png`), fullPage: true });
    observe(`${name} ${size} fits the viewport`, overflow);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/status`);
    await page.locator(".live-bar").waitFor();
    assert.equal(await page.locator('#side a[href="#/"]').count(), 1);
    assert.equal(await page.locator('#side a[href="#/settings"]').count(), 1);
    const snapshot = await page.evaluate(async () => (await fetch("/api/status")).json());
    for (const view of ["runs", "questions", "verdicts", "queue", "sessions", "epics"]) {
      await page.locator(`.work-navigation a[href="#/${view}"]`).click();
      assert.equal(new URL(page.url()).hash, `#/${view}`);
      assert.equal(await page.locator('#side [aria-current="page"]').innerText(), "Overview");
    }
    observe("All work details remain reachable under Overview", [
      "runs",
      "questions",
      "verdicts",
      "queue",
      "sessions",
      "epics",
    ]);
    await page.locator("#side .nav").filter({ hasText: "Overview" }).click();
    const run = snapshot.runs[0];
    assert.ok(run);
    await page.locator(`.overview-work a[href="#/runs/${encodeURIComponent(run.id)}"]`).click();
    await page.locator("#content .log").waitFor();
    observe("A real completed run opens its logs", run.id);
    await page.locator(".crumbs a").click();
    const parked = JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, "happy-parked.json"), "utf8"),
    );
    let refresh = 0;
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          ...parked,
          generatedAt: new Date(Date.parse(parked.generatedAt) + ++refresh * 120_000).toISOString(),
        },
      }),
    );
    await page.locator('[data-action="refresh"]').click();
    await page.locator("#content a").filter({ hasText: "Answer in Linear" }).first().waitFor();
    assert.equal(parked.source, "live");
    const focused = page.locator('.work-navigation a[href="#/questions"]');
    await focused.focus();
    const preserved = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            resolve(document.activeElement?.getAttribute("href"));
          });
          observer.observe(document.querySelector("#content"), { childList: true });
          document.querySelector('[data-action="refresh"]').click();
        }),
    );
    assert.equal(preserved, "#/questions");
    observe(
      "Live question handoff and focused link survive refresh",
      parked.questions.map(({ id, links }) => ({ id, links })),
    );
    await inspect(page, "overview");
    await page.route("**/api/status", (route) =>
      route.fulfill({ status: 503, body: "Fixture outage" }),
    );
    await page.locator('[data-action="refresh"]').click();
    await page.locator(".err-bar").waitFor();
    assert.match(await page.locator(".err-bar").innerText(), /Showing the last snapshot/);
    assert.ok(await page.locator("#content a").filter({ hasText: "Answer in Linear" }).count());
    observe(
      "Disconnected state preserves the last real snapshot",
      await page.locator(".err-bar").innerText(),
    );
    await page.unroute("**/api/status");
    await page.locator('[data-action="refresh"]').click();
    await page.locator(".live-bar").waitFor();
    await context.close();

    if (workspaceRoot) {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(workspaceRoot, "workspace-ui.json"), "utf8"),
      );
      assert.equal(new URL(fixture.origin).hostname, "127.0.0.1");
      const workspace = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const account = await workspace.newPage();
      account.on("pageerror", (error) => errors.push(String(error)));
      let identity = "owner";
      await workspace.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== fixture.origin) return route.abort();
        if (url.pathname !== "/auth/linear") return route.continue();
        const response = await route.fetch({ maxRedirects: 0 });
        const provider = new URL(response.headers().location);
        const callback = new URL(provider.searchParams.get("redirect_uri"));
        callback.searchParams.set("state", provider.searchParams.get("state"));
        callback.searchParams.set("code", identity);
        return route.fulfill({
          response,
          headers: { ...response.headers(), location: callback.href },
        });
      });
      await account.goto(`${fixture.origin}/status/`);
      await account.getByRole("heading", { name: "Sign in to Paws" }).waitFor();
      await account.locator("summary").filter({ hasText: "Set up your first workspace" }).click();
      await account.locator("input[name=bootstrap]").fill(fixture.bootstrap);
      await account.getByRole("button", { name: "Connect workspace" }).click();
      await account.getByRole("button", { name: "Sign out" }).waitFor();
      assert.equal(await account.locator("#workspace-members").isVisible(), false);
      await account.locator('#side a[href="#/settings"]').click();
      await account.locator("#workspace-members > summary").click();
      await account.locator('textarea[name="repositories"]').fill("fixture/repo fixture-team");
      await account.getByRole("button", { name: "Save repositories" }).click();
      await account.getByRole("status").filter({ hasText: "Repository access saved." }).waitFor();
      await inspect(account, "owner-settings");
      observe(
        "Owner administration is available in Settings and saves through the production API",
        "Repository access saved.",
      );
      await account.getByRole("button", { name: "Sign out" }).click();
      await account.getByRole("heading", { name: "Sign in to Paws" }).waitFor();
      identity = "member";
      await account.getByRole("link", { name: "Sign in with Linear" }).click();
      await account.getByRole("button", { name: "Sign out" }).waitFor();
      await account.locator('#tabbar a[href="#/settings"]').click();
      assert.equal(await account.locator("#workspace-members").count(), 0);
      assert.equal(await account.locator(".workspace-identities").count(), 0);
      observe("Member sign-in excludes owner and administrator controls", "member");
      await workspace.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(
      path.join(evidenceRoot, "dashboard-browser.json"),
      JSON.stringify({ observations, errors }, null, 2),
    );
  }
  console.log(JSON.stringify({ verified: true, observations: observations.length, evidenceRoot }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
