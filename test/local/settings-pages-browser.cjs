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
    const mobile = page.viewportSize().width < 768;
    if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
    const navigation = mobile
      ? page
          .getByRole("dialog", { name: "Paws navigation" })
          .getByRole("navigation", { name: "Main navigation" })
      : page.getByRole("navigation", { name: "Main navigation" });
    await navigation.getByRole("region", { name: "Settings", exact: true }).waitFor();
    assert.equal(
      await navigation
        .getByRole("region", { name: "Settings", exact: true })
        .getByRole("link")
        .count(),
      6,
    );
    await navigation.getByRole("link", { name, exact: true }).click();
    if (mobile)
      await page.getByRole("dialog", { name: "Paws navigation" }).waitFor({ state: "hidden" });
    await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator("#content h1").count(), 1);
    assert.equal(await page.locator('#content nav[aria-label="Settings pages"]').count(), 0);
  }
  async function control(context, body) {
    const response = await context.request.post(fixture.control, { data: body });
    assert.equal(response.status(), 200);
  }
  try {
    const { page, context } = await account("owner");
    await settings(page, "Agents");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText("Agent settings saved. New work will use these profiles.").waitFor();
    await settings(page, "Integrations");
    const github = page.locator("#workspace-github-integration");
    assert.equal(await page.locator("textarea[name=repositories]").count(), 0);
    assert.equal(
      await page.getByRole("link", { name: "Add repositories", exact: true }).count(),
      0,
    );
    await github.getByRole("button", { name: "Sign in with GitHub", exact: true }).waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: path.join(root, "github-signin-" + width + ".png"),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await github.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
    await github.getByText("@fixture-human", { exact: true }).waitFor();
    assert.deepEqual(
      await page.evaluate(
        async () => (await (await fetch("/api/workspaces/repositories")).json()).repositories,
      ),
      [],
    );
    observations.push({ githubSignInBeforeRepositoryConfiguration: true });
    const popupPromise = page.waitForEvent("popup");
    await github.getByRole("link", { name: "Choose repositories on GitHub" }).click();
    const popup = await popupPromise;
    await popup.getByText("Synthetic GitHub installation approved.").waitFor();
    await popup.close();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await github.getByRole("combobox", { name: "GitHub account" }).selectOption({ label: "acme" });
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Engineering", exact: true })
      .waitFor();
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Engineering", exact: true })
      .check();
    const permissions = github.getByRole("alert").filter({ hasText: "Read and write access" });
    await permissions.waitFor();
    assert.match(await permissions.innerText(), /Pull requests, Checks, Issues/);
    assert.equal(
      await github
        .getByRole("button", { name: "Save repository access", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await github
        .getByRole("link", { name: "Review GitHub App permissions" })
        .getAttribute("href"),
      "https://github.com/settings/installations",
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: path.join(root, "github-permissions-" + width + ".png"),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await control(context, { permissionsReady: true });
    await github.getByRole("button", { name: "Refresh repositories", exact: true }).click();
    await permissions.waitFor({ state: "hidden" });
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Engineering", exact: true })
      .check();
    assert.equal(
      await github.getByRole("button", { name: "Save repository access", exact: true }).isEnabled(),
      true,
    );
    observations.push({
      repositoriesVisibleWithMissingPermissions: true,
      permissionRecovery: true,
    });
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Quality", exact: true })
      .check();
    await github.getByRole("button", { name: "Next", exact: true }).click();
    await github
      .getByRole("checkbox", { name: "Match acme/service-25 to Engineering", exact: true })
      .check();
    await github.getByRole("button", { name: "Previous", exact: true }).click();
    assert.equal(
      await github
        .getByRole("checkbox", { name: "Match acme/widgets to Quality", exact: true })
        .isChecked(),
      true,
    );
    await github.getByRole("searchbox", { name: "Find a repository" }).fill("widgets");
    assert.equal(
      await github.getByRole("table", { name: "GitHub repositories" }).locator("tbody tr").count(),
      1,
    );
    await github.getByRole("button", { name: "Save repository access", exact: true }).click();
    await github.getByText("Repository access saved.", { exact: true }).waitFor();
    const mappings = await page.evaluate(
      async () => (await (await fetch("/api/workspaces/repositories")).json()).repositories,
    );
    assert.equal(mappings.length, 3);
    assert.equal(mappings.filter((entry) => entry.repository === "acme/widgets").length, 2);
    await github
      .getByText("Connected · 2 repositories available to Paws.", { exact: true })
      .waitFor();
    await control(context, { hiddenRepository: "acme/service-25" });
    await github.getByRole("button", { name: "Refresh repositories", exact: true }).click();
    await github.getByRole("button", { name: "Remove unavailable repository access" }).waitFor();
    assert.equal(
      await github
        .getByRole("button", { name: "Save repository access", exact: true })
        .isDisabled(),
      true,
    );
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Quality", exact: true })
      .uncheck();
    assert.equal(
      await github
        .getByRole("button", { name: "Save repository access", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate(
        async () =>
          (await (await fetch("/api/workspaces/repositories")).json()).repositories.length,
      ),
      3,
    );
    await github.getByRole("button", { name: "Remove unavailable repository access" }).click();
    await github.getByRole("button", { name: "Save repository access", exact: true }).click();
    await github.getByText("Repository access saved.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        async () =>
          (await (await fetch("/api/workspaces/repositories")).json()).repositories.length,
      ),
      1,
    );
    await control(context, { hiddenRepository: null });
    await github.getByRole("button", { name: "Refresh repositories", exact: true }).click();
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Quality", exact: true })
      .check();
    await github.getByRole("searchbox", { name: "Find a repository" }).fill("service-25");
    await github
      .getByRole("checkbox", { name: "Match acme/service-25 to Engineering", exact: true })
      .check();
    await github.getByRole("button", { name: "Save repository access", exact: true }).click();
    await github.getByText("Repository access saved.", { exact: true }).waitFor();
    observations.push({ unavailableMappingsPreservedUntilExplicitRemoval: true });
    await github.getByRole("searchbox", { name: "Find a repository" }).fill("widgets");
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Engineering", exact: true })
      .uncheck();
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Quality", exact: true })
      .uncheck();
    await github.getByRole("searchbox", { name: "Find a repository" }).fill("service-25");
    await github
      .getByRole("checkbox", { name: "Match acme/service-25 to Engineering", exact: true })
      .uncheck();
    await github
      .getByRole("button", { name: "Remove all repository access", exact: true })
      .waitFor();
    await github
      .getByRole("checkbox", { name: "Match acme/service-25 to Engineering", exact: true })
      .check();
    await github.getByRole("searchbox", { name: "Find a repository" }).fill("widgets");
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Engineering", exact: true })
      .check();
    await github
      .getByRole("checkbox", { name: "Match acme/widgets to Quality", exact: true })
      .check();
    observations.push({
      explicitRemoveAllAction: true,
      repositoryPicker: true,
      namedLinearTeams: true,
      githubAccountChoice: true,
      multipleTeamsPerRepository: true,
      selectionAcrossPagesAndSearch: true,
      realConnectionPersistence: true,
    });
    await settings(page, "Your account");
    await page.getByText("owner@example.invalid", { exact: true }).waitFor();
    const attribution = page.locator("#workspace-github-attribution");
    await control(context, { expire: true });
    await page.reload();
    await attribution.getByText("No verified GitHub attribution.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Sign in again" }).count(), 0);
    assert.equal(
      await attribution.getByRole("button", { name: "Link GitHub identity" }).isDisabled(),
      true,
    );
    await attribution.getByRole("checkbox").check();
    assert.equal(
      await attribution.getByRole("button", { name: "Link GitHub identity" }).isEnabled(),
      true,
    );
    observations.push({
      staleAttributionReadRecovery: true,
      accountReturnRestored: true,
      explicitConsentRequired: true,
    });
    await attribution.getByRole("button", { name: "Link GitHub identity" }).click();
    await page.waitForURL((url) => url.pathname === "/status/settings/account");
    await attribution.getByText("Public attribution is enabled for @fixture-human.").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).isVisible(),
      false,
    );
    await settings(page, "Audit history");
    await page.getByRole("button", { name: "Refresh history" }).click();
    await page
      .getByRole("table", { name: "Workspace audit changes" })
      .getByText("github attribution consented", { exact: true })
      .waitFor();
    assert.deepEqual(
      await page
        .getByRole("table", { name: "Workspace audit changes" })
        .getByRole("columnheader")
        .allTextContents(),
      ["Time", "Change", "Person", "Details"],
    );
    assert.equal(
      (await page
        .getByRole("table", { name: "Workspace audit changes" })
        .locator("tbody tr")
        .count()) > 0,
      true,
    );
    observations.push({
      auditUsesSemanticTable: true,
      profilesSave: true,
      repositoryAccessSave: true,
      attributionOnAccountPage: true,
      auditRead: true,
    });
    await settings(page, "Integrations");
    await github.getByRole("button", { name: "Switch GitHub account", exact: true }).waitFor();
    await github.getByRole("table", { name: "GitHub repositories" }).waitFor();
    assert.equal(await github.getByRole("combobox", { name: "GitHub account" }).inputValue(), "22");
    for (const width of [1440, 768, 390]) {
      for (const appearance of ["Light", "Dark"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page
          .getByRole("combobox", { name: "Appearance" })
          .selectOption({ label: appearance });
        for (const name of [
          "Decisions",
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
          const hash = await page.evaluate(() => location.hash);
          await page.reload();
          await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
          assert.equal(await page.evaluate(() => location.hash), hash);
          assert.equal(await page.title(), `Paws status · ${name}`);
          if (name === "Audit history" && width === 390) {
            const audit = page.getByRole("table", { name: "Workspace audit changes" });
            await audit.focus();
            await page.keyboard.press("ArrowRight");
            await page.waitForFunction(
              () =>
                document.querySelector('[aria-label="Workspace audit changes"]').parentElement
                  .scrollLeft > 0,
            );
            await audit.evaluate((table) => {
              table.parentElement.scrollLeft = 0;
            });
          }
          if ([1440, 390].includes(width) && ["Integrations", "Audit history"].includes(name))
            await page.screenshot({
              path: path.join(
                root,
                `settings-${name === "Integrations" ? "integrations" : "audit"}-${width}-${appearance.toLowerCase()}.png`,
              ),
              fullPage: true,
            });
        }
        observations.push({
          width,
          appearance,
          sixPages: true,
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
    await member.page.getByText("Only workspace admins can change agent profiles.").waitFor();
    await settings(member.page, "Audit history");
    await member.page.getByText("Audit history is available to workspace admins.").waitFor();
    observations.push({
      memberStatusVisible: true,
      administratorControlsHidden: true,
      adminAgentControlsPreserved: true,
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
    await settings(member.page, "Integrations");
    const adminGitHub = member.page.locator("#workspace-github-integration");
    await control(context, { disconnect: true });
    await adminGitHub.getByRole("button", { name: "Refresh status" }).click();
    await adminGitHub.getByRole("button", { name: "Connect GitHub" }).waitFor();
    await control(context, { expire: true });
    await adminGitHub.getByRole("button", { name: "Connect GitHub" }).click();
    await adminGitHub.getByText("Connected", { exact: true }).waitFor();
    assert.equal(await member.page.getByRole("link", { name: "Sign in again" }).count(), 0);
    observations.push({ olderSignInConnectsGitHub: true });
    await control(context, { unavailable: true });
    await adminGitHub.getByRole("button", { name: "Refresh status" }).click();
    await adminGitHub.getByText("Connection unavailable", { exact: true }).waitFor();
    await control(context, { unavailable: false });
    await adminGitHub.getByRole("button", { name: "Refresh status" }).click();
    await adminGitHub.getByText("Connected", { exact: true }).waitFor();
    const api = `${fixture.origin}/api/workspaces/github-connect`;
    await member.context.route(api, (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
    );
    await adminGitHub.getByRole("button", { name: "Refresh status" }).click();
    await adminGitHub
      .getByText("GitHub could not be checked. Refresh status to try again.")
      .waitFor();
    await member.context.unroute(api);
    await adminGitHub.getByRole("button", { name: "Refresh status" }).click();
    await adminGitHub.getByText("Connected", { exact: true }).waitFor();
    assert.equal((await page.content()).includes("synthetic-client-secret"), false);
    assert.equal((await page.content()).includes("PRIVATE KEY"), false);
    await settings(page, "Your account");
    await attribution.getByRole("button", { name: "Refresh attribution" }).click();
    await attribution.getByRole("button", { name: "Revoke attribution consent" }).click();
    await attribution.getByText("No verified GitHub attribution.", { exact: false }).waitFor();
    observations.push({ consentRevocation: true });
    await control(context, { expire: true });
    await attribution.getByRole("checkbox").check();
    await attribution.getByRole("button", { name: "Link GitHub identity" }).click();
    await attribution.getByText("Public attribution is enabled for @fixture-human.").waitFor();
    observations.push({ olderSignInLinksAttribution: true });
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
