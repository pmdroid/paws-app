const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");
const root = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(path.join(root, "workspace-ui.json"), "utf8"));
assert.equal(new URL(fixture.origin).hostname, "127.0.0.1");
assert.equal(new URL(fixture.control).hostname, "127.0.0.1");
const observations = [];
const errors = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  async function account(identity) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "https://github.com") {
        if (url.pathname.endsWith("/installations/new")) {
          await context.request.post(fixture.control, { data: { installed: true } });
          return route.fulfill({
            contentType: "text/html",
            body: "<p>Synthetic GitHub installation approved.</p>",
          });
        }
        if (url.pathname === "/login/oauth/authorize") {
          const callback = new URL(url.searchParams.get("redirect_uri"));
          callback.searchParams.set("state", url.searchParams.get("state"));
          callback.searchParams.set("code", "synthetic-human-code");
          return route.fulfill({ status: 302, headers: { location: callback.href } });
        }
      }
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
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${fixture.origin}/status/`);
    if (identity === "owner") {
      await page.getByText("Set up your first workspace", { exact: true }).click();
      await page.locator("input[name=bootstrap]").fill(fixture.bootstrap);
      await page.getByRole("button", { name: "Connect workspace" }).click();
    } else await page.getByRole("link", { name: "Sign in with Linear", exact: true }).click();
    await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
    return { page, context };
  }
  async function settings(page, name) {
    const navigation = page.getByRole("navigation", { name: "Settings pages" });
    if (!(await navigation.isVisible())) {
      if (page.viewportSize().width < 768)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Settings", exact: true })
        .click();
    }
    await navigation.getByRole("link", { name, exact: true }).click();
    await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator("#content h1").count(), 1);
  }
  async function control(context, body) {
    const response = await context.request.post(fixture.control, { data: body });
    assert.equal(response.status(), 200);
  }
  try {
    const { page, context } = await account("owner");
    await settings(page, "Agents");
    await page.locator("#agent-settings-form").waitFor();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText("Agent settings saved. New work will use these profiles.").waitFor();
    await settings(page, "Workspace access");
    await page.locator("textarea[name=repositories]").fill("acme/widgets fixture-team");
    await page.getByRole("button", { name: "Save repositories" }).click();
    await page.getByText("Repository access saved.", { exact: true }).waitFor();
    await settings(page, "Integrations");
    const github = page.locator("#workspace-github-integration");
    await github.getByText("Not installed", { exact: true }).waitFor();
    assert.equal(await page.locator("input[name=installationId]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Revalidate GitHub App" }).count(), 0);
    const popupPromise = page.waitForEvent("popup");
    await github.getByRole("link", { name: "Install GitHub App" }).click();
    const popup = await popupPromise;
    await popup.getByText("Synthetic GitHub installation approved.").waitFor();
    await popup.close();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await github.getByText("Connected", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), "#/settings/integrations");
    observations.push({
      automaticInstallationDiscovery: true,
      scriptedGitHubApproval: true,
      realConnectionPersistence: true,
    });
    await settings(page, "Your account");
    await page.getByText("owner@example.invalid", { exact: true }).waitFor();
    const attribution = page.locator("#workspace-github-attribution");
    await attribution.getByRole("checkbox").check();
    await attribution.getByRole("button", { name: "Link GitHub identity" }).click();
    await page.waitForURL((url) => url.hash === "#/settings/account");
    await attribution.getByText("Public attribution is enabled for @fixture-human.").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).isVisible(),
      false,
    );
    await settings(page, "Audit history");
    await page.getByRole("button", { name: "Refresh history" }).click();
    await page
      .getByRole("list", { name: "Workspace audit changes" })
      .getByText("github attribution consented", { exact: true })
      .waitFor();
    observations.push({
      profilesSave: true,
      repositoryAccessSave: true,
      attributionOnAccountPage: true,
      auditRead: true,
    });
    for (const width of [1440, 768, 390]) {
      for (const appearance of ["Light", "Dark"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page
          .getByRole("combobox", { name: "Appearance" })
          .selectOption({ label: appearance });
        for (const name of [
          "Agents",
          "Integrations",
          "Workspace access",
          "Your account",
          "Audit history",
        ]) {
          await settings(page, name);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${name} ${width}`,
          );
          assert.equal(
            await page
              .getByRole("navigation", { name: "Settings pages" })
              .getByRole("link")
              .count(),
            5,
          );
          if ([1440, 390].includes(width) && ["Integrations", "Workspace access"].includes(name))
            await page.screenshot({
              path: path.join(
                root,
                `settings-${name === "Integrations" ? "integrations" : "workspace"}-${width}-${appearance.toLowerCase()}.png`,
              ),
              fullPage: true,
            });
        }
        observations.push({
          width,
          appearance,
          fivePages: true,
          noOverflow: true,
          oneHeading: true,
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const member = await account("member");
    await settings(member.page, "Integrations");
    await member.page
      .locator("#workspace-github-integration")
      .getByText("Connected", { exact: true })
      .waitFor();
    assert.equal(await member.page.getByRole("link", { name: "Manage on GitHub" }).count(), 0);
    await settings(member.page, "Workspace access");
    assert.equal(await member.page.getByRole("button", { name: "Save repositories" }).count(), 0);
    await settings(member.page, "Agents");
    await member.page.getByText("Only workspace owners can change agent profiles.").waitFor();
    await settings(member.page, "Audit history");
    await member.page
      .getByText("Audit history is available to workspace owners and admins.")
      .waitFor();
    observations.push({
      memberStatusVisible: true,
      administratorControlsHidden: true,
      ownerAgentControlsPreserved: true,
    });
    await settings(page, "Workspace access");
    await page.getByRole("button", { name: "Refresh members" }).click();
    const row = page.locator(".workspace-member").filter({ hasText: "Fixture member" }).first();
    await row.getByRole("combobox").selectOption("admin");
    await row.getByRole("button", { name: "Save role" }).click();
    await page.getByText("Workspace role saved.", { exact: true }).waitFor();
    await member.page.reload();
    await settings(member.page, "Integrations");
    await member.page.getByRole("link", { name: "Manage on GitHub" }).waitFor();
    observations.push({ administratorPromotion: true });
    await settings(page, "Integrations");
    await control(context, { disconnect: true });
    await github.getByRole("button", { name: "Refresh status" }).click();
    await github.getByRole("button", { name: "Connect GitHub" }).waitFor();
    await control(context, { expire: true });
    await github.getByRole("button", { name: "Connect GitHub" }).click();
    await github.getByRole("link", { name: "Sign in again" }).waitFor();
    await github.getByRole("link", { name: "Sign in again" }).click();
    await page.waitForURL((url) => url.hash === "#/settings/integrations");
    await github.getByRole("button", { name: "Connect GitHub" }).click();
    await github.getByText("Connected", { exact: true }).waitFor();
    observations.push({ expiredSignInRecovery: true, settingsReturnRestored: true });
    await control(context, { unavailable: true });
    await github.getByRole("button", { name: "Refresh status" }).click();
    await github.getByText("Connection unavailable", { exact: true }).waitFor();
    await control(context, { unavailable: false });
    await github.getByRole("button", { name: "Refresh status" }).click();
    await github.getByText("Connected", { exact: true }).waitFor();
    const api = `${fixture.origin}/api/workspaces/github-connect`;
    await context.route(api, (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
    );
    await github.getByRole("button", { name: "Refresh status" }).click();
    await github.getByText("GitHub could not be checked. Refresh status to try again.").waitFor();
    await context.unroute(api);
    await github.getByRole("button", { name: "Refresh status" }).click();
    await github.getByText("Connected", { exact: true }).waitFor();
    assert.equal((await page.content()).includes("synthetic-client-secret"), false);
    assert.equal((await page.content()).includes("PRIVATE KEY"), false);
    await settings(page, "Your account");
    await attribution.getByRole("button", { name: "Revoke attribution consent" }).click();
    await attribution.getByText("No verified GitHub attribution.", { exact: false }).waitFor();
    observations.push({ consentRevocation: true });
    assert.deepEqual(errors, []);
    observations.push({
      providerOutageRecovery: true,
      plainTextErrorRecovery: true,
      noSecretsInPage: true,
      consoleErrors: 0,
    });
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(root, "settings-pages-browser.json"),
    JSON.stringify(observations, null, 2),
  );
  console.log(JSON.stringify(observations));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
