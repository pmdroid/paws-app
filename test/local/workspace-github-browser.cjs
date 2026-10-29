const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PAWS_PLAYWRIGHT_MODULE || "playwright");

const root = process.argv[2];
if (!root) throw new Error("Use the workspace-serve evidence directory.");
const baseline = process.argv[3] === "baseline";
const lookupBaseline = process.argv[3] === "lookup-baseline";
const fixture = JSON.parse(fs.readFileSync(path.join(root, "workspace-ui.json"), "utf8"));
if (new URL(fixture.origin).hostname !== "127.0.0.1") throw new Error("Use the loopback fixture.");
const observations = [];
const errors = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const contexts = [];
  try {
    async function account(identity) {
      const context = await browser.newContext();
      contexts.push(context);
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
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${fixture.origin}/status/`);
      await page.getByRole("heading", { name: "Sign in to Paws" }).waitFor();
      if (identity === "owner") {
        await page.locator("summary").filter({ hasText: "Set up your first workspace" }).click();
        await page.locator("input[name=bootstrap]").fill(fixture.bootstrap);
        await page.getByRole("button", { name: "Connect workspace" }).click();
      } else await page.getByRole("link", { name: "Sign in with Linear" }).click();
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      await page.locator('#side a[href="#/settings"]').click();
      await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/status");
      return page;
    }
    const owner = await account("owner");
    const member = await account("member");
    await owner.getByRole("button", { name: "Sign in with GitHub", exact: true }).waitFor();
    assert.equal(await owner.evaluate(async () => (await fetch("/api/auth/github")).status), 200);
    await owner.locator("#agent-settings-form").waitFor();
    observations.push("Owner retains GitHub setup and its authorized HTTP read");
    const memberId = await member.evaluate(
      async () => (await (await fetch("/api/auth/session")).json()).userId,
    );
    async function reloadSettings(page) {
      await page.reload();
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/status");
    }
    for (const role of ["member", "admin"]) {
      if (role === "admin") {
        assert.equal(
          await owner.evaluate(async (userId) => {
            const session = await (await fetch("/api/auth/session")).json();
            return (
              await fetch("/api/workspaces/members", {
                method: "PUT",
                headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
                body: JSON.stringify({ userId, role: "admin" }),
              })
            ).status;
          }, memberId),
          200,
        );
        await member.reload();
        await member.getByRole("button", { name: "Sign out" }).waitFor();
        await member.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/status",
        );
      }
      const read = await member.evaluate(async () => (await fetch("/api/auth/github")).status);
      const write = await member.evaluate(async () => {
        const session = await (await fetch("/api/auth/session")).json();
        return (
          await fetch("/api/auth/github/device", {
            method: "POST",
            headers: { "x-paws-csrf": session.csrfToken },
          })
        ).status;
      });
      assert.equal(read, 403);
      assert.equal(write, 403);
      const settings = await member.evaluate(async () => {
        const session = await (await fetch("/api/auth/session")).json();
        return Promise.all([
          fetch("/api/settings/agents").then((response) => response.status),
          fetch("/api/settings/agents", {
            method: "PUT",
            headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
            body: JSON.stringify({}),
          }).then((response) => response.status),
        ]);
      });
      assert.deepEqual(settings, [403, 403]);
      await member.waitForFunction(
        (expected) =>
          document.querySelectorAll('[data-action="github-signin"]').length === expected,
        baseline ? 1 : 0,
      );
      assert.equal(await member.locator('[data-settings="reload"]').count(), baseline ? 1 : 0);
      assert.equal(await member.locator("#agent-settings-form").count(), 0);
      observations.push({
        role,
        read,
        write,
        settings,
        signInControls: baseline ? 1 : 0,
        settingsRetries: baseline ? 1 : 0,
      });
      if (!baseline) {
        for (const failure of ["abort", "unavailable"]) {
          await member.route("**/api/auth/github", (route) =>
            failure === "abort"
              ? route.abort()
              : route.fulfill({ status: 503, json: { error: "Fixture GitHub outage" } }),
          );
          await reloadSettings(member);
          assert.equal(
            await member.locator('[data-action="github-signin"]').count(),
            lookupBaseline ? 1 : 0,
          );
          observations.push({
            role,
            lookupFailure: failure,
            signInControls: lookupBaseline ? 1 : 0,
          });
          await member.unroute("**/api/auth/github");
          await reloadSettings(member);
        }
      }
    }
    for (const [width, height, size] of [
      [1440, 1000, "desktop"],
      [390, 844, "mobile"],
    ]) {
      await member.setViewportSize({ width, height });
      await member.waitForFunction(
        () =>
          innerWidth > 900 || document.querySelector("#side").getBoundingClientRect().right <= 0,
      );
      await member.screenshot({
        path: path.join(root, `workspace-github-${size}.png`),
        fullPage: true,
      });
    }
    if (!baseline) {
      for (const failure of ["abort", "unavailable"]) {
        await owner.route("**/api/auth/github", (route) =>
          failure === "abort"
            ? route.abort()
            : route.fulfill({ status: 503, json: { error: "Fixture GitHub outage" } }),
        );
        await reloadSettings(owner);
        assert.equal(
          await owner.locator('[data-action="github-signin"]').count(),
          lookupBaseline ? 1 : 0,
        );
        await owner.unroute("**/api/auth/github");
        await owner.getByRole("button", { name: "Refresh", exact: true }).click();
        await owner.getByRole("button", { name: "Sign in with GitHub", exact: true }).waitFor();
        observations.push({
          ownerLookupFailure: failure,
          initialControls: lookupBaseline ? 1 : 0,
          controlsAfterRefresh: 1,
        });
      }
      assert.equal(
        await owner.evaluate(async (userId) => {
          const session = await (await fetch("/api/auth/session")).json();
          return (
            await fetch("/api/workspaces/members", {
              method: "PUT",
              headers: { "content-type": "application/json", "x-paws-csrf": session.csrfToken },
              body: JSON.stringify({ userId, role: "admin" }),
            })
          ).status;
        }, memberId),
        200,
      );
      assert.equal(
        await member.evaluate(async () => (await (await fetch("/api/auth/session")).json()).role),
        "owner",
      );
      assert.match(await member.locator("#workspace-access > .row").innerText(), /admin/);
      await reloadSettings(member);
      await member.locator("#agent-settings-form").waitFor();
      await member.getByRole("button", { name: "Sign in with GitHub", exact: true }).waitFor();
      assert.match(await member.locator("#workspace-access > .row").innerText(), /owner/);
      observations.push(
        "Role promotion takes effect in existing workspace controls and agent settings on session reload",
      );
    }
    await owner.route("**/api/settings/agents", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture settings outage" } }),
    );
    await owner.reload();
    await owner.getByRole("button", { name: "Try again", exact: true }).waitFor();
    await owner.unroute("**/api/settings/agents");
    await owner.getByRole("button", { name: "Try again", exact: true }).click();
    await owner.locator("#agent-settings-form").waitFor();
    observations.push("Owner settings retain outage retry and recover the editable form");
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
    fs.writeFileSync(
      path.join(root, "workspace-github-browser.json"),
      JSON.stringify({ baseline, lookupBaseline, observations, errors }, null, 2),
    );
  }
  console.log(JSON.stringify({ baseline, lookupBaseline, observations, errors, root }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
