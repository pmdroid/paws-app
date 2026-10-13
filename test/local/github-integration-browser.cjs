const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");
const root = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(path.join(root, "workspace-ui.json"), "utf8"));
const observations = [];
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PAWS_BROWSER_BINARY ? { executablePath: process.env.PAWS_BROWSER_BINARY } : {}),
  });
  try {
    async function account(identity) {
      const context = await browser.newContext();
      await context.route("**/*", async (route) => {
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
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/status/`);
      await page.getByRole("heading", { name: "Sign in to Paws" }).waitFor();
      if (identity === "owner") {
        await page.locator("summary").filter({ hasText: "Set up your first workspace" }).click();
        await page.locator("input[name=bootstrap]").fill(fixture.bootstrap);
        await page.getByRole("button", { name: "Connect workspace" }).click();
      } else await page.getByRole("link", { name: "Sign in with Linear" }).click();
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      await page.locator('#side a[href="#/settings"]').click();
      return page;
    }
    const owner = await account("owner");
    const member = await account("member");
    await owner.locator("#workspace-github-integration").waitFor();
    assert.equal(await member.locator("#workspace-github-integration").count(), 0);
    assert.equal(
      await member.evaluate(async () => (await fetch("/api/workspaces/github-integration")).status),
      403,
    );
    const userId = await member.evaluate(
      async () => (await (await fetch("/api/auth/session")).json()).userId,
    );
    assert.equal(
      await owner.evaluate(async (targetUserId) => {
        const session = await (await fetch("/api/auth/session")).json();
        return (
          await fetch("/api/workspaces/members", {
            method: "PUT",
            headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
            body: JSON.stringify({ userId: targetUserId, role: "admin" }),
          })
        ).status;
      }, userId),
      200,
    );
    await member.reload();
    await member.locator("#workspace-github-integration").waitFor();
    assert.equal(await member.locator("#workspace-members").count(), 0);
    await member.locator("#workspace-github-integration summary").click();
    for (const [name, width] of [
      ["desktop", 1440],
      ["mobile", 390],
    ]) {
      await member.setViewportSize({ width, height: 1000 });
      const button = member.getByRole("button", { name: "Revalidate GitHub App", exact: true });
      await button.focus();
      await member.keyboard.press("Enter");
      await member
        .locator('#workspace-github-integration [role="status"]')
        .filter({ hasText: "Restore the configured" })
        .waitFor();
      assert.equal(await button.isEnabled(), true);
      assert.equal(
        await member.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await member.waitForTimeout(350);
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      await member.screenshot({
        path: path.join(root, `github-integration-${name}.png`),
        fullPage: true,
      });
      observations.push({
        viewport: name,
        width,
        administratorRecoveryVisible: true,
        ownerRoleManagementHidden: true,
        keyboardRetry: true,
        unavailableInstallationDenied: true,
        overflow: false,
      });
    }
    fs.writeFileSync(
      path.join(root, "github-integration-browser.json"),
      JSON.stringify(observations, null, 2),
    );
    console.log(JSON.stringify(observations));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
