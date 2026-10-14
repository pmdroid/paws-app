const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");
const root = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(path.join(root, "workspace-ui.json"), "utf8"));
async function openSettings(page) {
  if (page.viewportSize().width < 768)
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await page.locator("#content h1").filter({ hasText: "Settings" }).waitFor();
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PAWS_BROWSER_BINARY,
  });
  const observations = [];
  try {
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize") {
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("code", "synthetic-human-code");
        return route.fulfill({ status: 302, headers: { location: callback.href } });
      }
      if (url.origin !== fixture.origin) return route.abort();
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
    await page.goto(`${fixture.origin}/status/`);
    await page.locator("summary").filter({ hasText: "Set up your first workspace" }).click();
    await page.locator("input[name=bootstrap]").fill(fixture.bootstrap);
    await page.getByRole("button", { name: "Connect workspace" }).click();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    await openSettings(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const section = page.locator("#workspace-github-attribution");
      await section.locator("summary").click();
      await section.getByText("No verified GitHub attribution.", { exact: false }).waitFor();
      await section.getByRole("checkbox").check();
      await section.getByRole("button", { name: "Link GitHub identity" }).click();
      await page.waitForURL((url) => url.pathname === "/status" && !url.search);
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      await openSettings(page);
      await page.locator("#workspace-github-attribution summary").click();
      await page.getByText("Public attribution is enabled for @fixture-human.").waitFor();
      await page.locator("#workspace-github-integration summary").click();
      await page.getByRole("button", { name: "Connect or reconnect GitHub App" }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, `attribution-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Revoke attribution consent" }).click();
      await page.getByText("No verified GitHub attribution.", { exact: false }).waitFor();
      observations.push({
        width,
        explicitConsent: true,
        scriptedHostedOAuth: true,
        verifiedHuman: true,
        revoke: true,
        installationConnectVisible: true,
        noOverflow: true,
      });
      await page.locator("#workspace-github-attribution summary").click();
    }
    const section = page.locator("#workspace-github-attribution");
    await section.locator("summary").click();
    const attributionApi = `${fixture.origin}/api/workspaces/github-attribution`;
    await context.route(attributionApi, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: false, identity: null }),
      }),
    );
    await section.getByRole("button", { name: "Refresh attribution" }).click();
    await section
      .getByText(
        "Ask the Paws operator to configure the GitHub App on the server, then restart Paws.",
      )
      .waitFor();
    assert.equal(
      await section.getByRole("button", { name: "Link GitHub identity" }).isDisabled(),
      true,
    );
    observations.push({
      missingServerCredentials: true,
      linkingDisabled: true,
      noSecretInputs: (await section.locator("input[type=password]").count()) === 0,
    });
    await context.unroute(attributionApi);
    await context.route(attributionApi, (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
    );
    await section.getByRole("button", { name: "Refresh attribution" }).click();
    await section.getByText("Attribution could not be checked. Try Refresh attribution.").waitFor();
    assert.equal(
      await section.getByRole("button", { name: "Link GitHub identity" }).isDisabled(),
      true,
    );
    await context.unroute(attributionApi);
    await section.getByRole("button", { name: "Refresh attribution" }).click();
    await section.getByText("No verified GitHub attribution.", { exact: false }).waitFor();
    assert.equal(
      await section.getByRole("button", { name: "Link GitHub identity" }).isEnabled(),
      true,
    );
    observations.push({ nonJsonAttributionError: true, refreshRecovery: true });
    const integration = page.locator("#workspace-github-integration");
    const connectApi = `${fixture.origin}/api/workspaces/github-connect`;
    await context.route(connectApi, (route) =>
      route.fulfill({ status: 503, contentType: "text/plain", body: "not found" }),
    );
    await integration.locator("input[name=installationId]").fill("22");
    await integration.getByRole("button", { name: "Connect or reconnect GitHub App" }).click();
    await integration.getByText("Connection could not start.", { exact: true }).waitFor();
    assert.equal(
      await integration
        .getByRole("button", { name: "Connect or reconnect GitHub App" })
        .isEnabled(),
      true,
    );
    const validationApi = `${fixture.origin}/api/workspaces/github-integration`;
    await context.route(validationApi, (route) =>
      route.fulfill({ status: 503, contentType: "text/plain", body: "not found" }),
    );
    await integration.getByRole("button", { name: "Revalidate GitHub App", exact: true }).click();
    await integration.getByText("GitHub App access could not be checked. Try again.").waitFor();
    assert.equal(
      await integration
        .getByRole("button", { name: "Revalidate GitHub App", exact: true })
        .isEnabled(),
      true,
    );
    observations.push({
      nonJsonConnectError: true,
      nonJsonRevalidationError: true,
      retryEnabled: true,
    });
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(root, "attribution-browser.json"),
    JSON.stringify(observations, null, 2),
  );
  console.log(JSON.stringify(observations));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
