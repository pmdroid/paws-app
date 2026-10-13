const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");

const root = process.argv[2];
if (!root) throw new Error("Use the evidence directory from verify:local workspace-serve.");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "workspace-ui.json"), "utf8"));
if (new URL(fixture.origin).hostname !== "127.0.0.1") throw new Error("Use the loopback fixture.");
const observations = [];
const errors = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const contexts = [];
  try {
    async function account(identity) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== fixture.origin) return route.abort();
        if (url.pathname !== "/auth/linear") return route.continue();
        const response = await route.fetch({ maxRedirects: 0 });
        const provider = new URL(response.headers().location);
        assert.equal(provider.searchParams.get("actor"), "user");
        assert.equal(provider.searchParams.get("scope"), "read");
        assert.equal(provider.searchParams.get("code_challenge_method"), "S256");
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
      await page.getByRole("heading", { name: "Sign in to Paws" }).waitFor();
      if (identity === "owner") {
        await page.locator("summary").filter({ hasText: "Set up your first workspace" }).click();
        await page.locator("input[name=bootstrap]").fill(fixture.bootstrap);
        await page.getByRole("button", { name: "Connect workspace" }).click();
      } else await page.getByRole("link", { name: "Sign in with Linear" }).click();
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      return { context, page };
    }
    const owner = await account("owner");
    const member = await account("member");
    const identities = await Promise.all(
      [owner, member].map(({ page }) =>
        page.evaluate(async () => ({
          session: await (await fetch("/api/auth/session")).json(),
          status: await (await fetch("/api/status")).json(),
        })),
      ),
    );
    assert.notEqual(identities[0].session.userId, identities[1].session.userId);
    assert.equal(identities[0].session.workspaceId, identities[1].session.workspaceId);
    assert.equal(identities[0].session.role, "owner");
    assert.equal(identities[1].session.role, "member");
    assert.deepEqual(identities[0].status.items, identities[1].status.items);
    observations.push(
      "Two independent Linear browser sessions read the same permitted live workspace",
    );
    const cookies = await owner.context.cookies();
    assert.ok(
      cookies.some(
        (cookie) =>
          cookie.name === "__Host-paws-session" &&
          cookie.secure &&
          cookie.httpOnly &&
          cookie.sameSite === "Lax",
      ),
    );
    await owner.page.bringToFront();
    await owner.page.evaluate(async () => {
      const session = await (await fetch("/api/auth/session")).json();
      for (let index = 0; index < 55; index++) {
        const response = await fetch("/api/workspaces/repositories", {
          method: "PUT",
          headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
          body: JSON.stringify({
            repositories: [{ repository: "fixture/repo", teamId: "fixture-team" }],
          }),
        });
        if (response.status !== 200)
          throw new Error(`Repository mutation failed: ${response.status}`);
      }
    });
    await owner.page.locator('#side a[href="#/settings"]').click();
    const summary = owner.page.locator(".workspace-audit summary");
    const historyResponse = owner.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/workspaces/audit",
    );
    await summary.focus();
    assert.equal(await summary.evaluate((element) => element.parentElement.open), false);
    await summary.press("Enter");
    assert.equal(await summary.evaluate((element) => element.parentElement.open), true);
    assert.equal((await historyResponse).status(), 200);
    await owner.page.waitForFunction(
      () => document.querySelectorAll(".workspace-audit li").length === 50,
      undefined,
      { polling: 100 },
    );
    assert.match(await owner.page.locator(".workspace-audit ol").innerText(), /Fixture owner/);
    await owner.page.getByRole("button", { name: "Load older changes" }).click();
    await owner.page.waitForFunction(
      () => document.querySelectorAll(".workspace-audit li").length > 50,
      undefined,
      { polling: 100 },
    );
    const loaded = await owner.page.locator(".workspace-audit li").count();
    observations.push("Keyboard disclosure loads actor-bound audit rows and older pages");
    await owner.page.route("**/api/workspaces/audit*", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture outage" } }),
    );
    await owner.page.getByRole("button", { name: "Refresh history" }).click();
    await owner.page
      .locator(".workspace-audit [role=status]")
      .filter({ hasText: "Refresh to try again" })
      .waitFor();
    assert.equal(await owner.page.locator(".workspace-audit li").count(), loaded);
    await owner.page.unroute("**/api/workspaces/audit*");
    await owner.page.getByRole("button", { name: "Refresh history" }).click();
    await owner.page.waitForFunction(
      () => document.querySelectorAll(".workspace-audit li").length === 50,
      undefined,
      { polling: 100 },
    );
    observations.push("Outage retains loaded history and refresh recovers the latest page");
    const list = owner.page.locator(".workspace-audit ol");
    await list.focus();
    await list.press("PageDown");
    await owner.page.waitForFunction(
      () => document.querySelector(".workspace-audit ol").scrollTop > 0,
    );
    observations.push("Long audit pages remain keyboard-scrollable within Settings");
    for (const [width, height, size] of [
      [1440, 1000, "desktop"],
      [390, 844, "mobile"],
    ]) {
      await owner.page.setViewportSize({ width, height });
      await owner.page.waitForFunction(
        () =>
          innerWidth > 900 || document.querySelector("#side").getBoundingClientRect().right <= 0,
      );
      assert.ok(
        await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
      await owner.page.screenshot({
        path: path.join(root, `workspace-audit-${size}.png`),
        fullPage: true,
      });
      observations.push(`Audit history fits ${size}`);
    }
    await member.page.bringToFront();
    await member.page.locator('#side a[href="#/settings"]').click();
    assert.equal(await member.page.locator(".workspace-audit").count(), 0);
    assert.equal(
      await member.page.evaluate(async () => (await fetch("/api/workspaces/audit")).status),
      403,
    );
    assert.equal(
      await member.page.evaluate(async () => {
        const session = await (await fetch("/api/auth/session")).json();
        return (
          await fetch("/api/workspaces/repositories", {
            method: "PUT",
            headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
            body: JSON.stringify({ repositories: [] }),
          })
        ).status;
      }),
      403,
    );
    observations.push("Members cannot read audit history or mutate workspace administration");
    await member.page.getByRole("button", { name: "Sign out" }).click();
    await member.page.getByRole("heading", { name: "Sign in to Paws" }).waitFor();
    assert.equal(
      await owner.page.evaluate(async () => (await fetch("/api/auth/session")).status),
      200,
    );
    observations.push("Member sign-out preserves the owner's independent session");
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
    fs.writeFileSync(
      path.join(root, "workspace-audit-browser.json"),
      JSON.stringify({ observations, errors }, null, 2),
    );
  }
  console.log(JSON.stringify({ passed: observations.length, errors, root }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
