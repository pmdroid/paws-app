const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = process.argv[2],
    bun = process.argv[3];
  const child = spawn(bun, ["--no-env-file", "test/local/onboarding.ts", root], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let browser;
  try {
    const manifest = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Fixture timeout")), 10000);
      child.once("exit", (code) => reject(Error(`Fixture exited ${code}`)));
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
    const observations = [],
      errors = [];
    for (const [name, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize") {
          const callback = new URL("/auth/member-github/callback", manifest.origin);
          callback.searchParams.set("state", url.searchParams.get("state"));
          callback.searchParams.set("code", "fixture");
          return route.fulfill({ status: 302, headers: { location: callback.href }, body: "" });
        }
        if (url.origin !== manifest.origin) return route.abort();
        if (url.pathname === "/auth/linear") {
          const response = await route.fetch({ maxRedirects: 0 });
          const provider = new URL(response.headers().location);
          const callback = new URL("/auth/linear/callback", manifest.origin);
          callback.searchParams.set("state", provider.searchParams.get("state"));
          callback.searchParams.set("code", "member");
          return route.fulfill({
            response,
            headers: { ...response.headers(), location: callback.href },
          });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.text().includes("PRIVATE"))
          errors.push("Private challenge appeared in console");
      });
      if (name === "desktop") {
        await page.goto(manifest.origin + manifest.assignment);
        await page.waitForURL(manifest.origin + manifest.page);
      } else {
        const cookies = JSON.parse(fs.readFileSync(path.join(root, "session.json")));
        await context.addCookies(cookies);
        await page.goto(manifest.origin + manifest.page);
      }
      await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
      assert((await page.locator("body").innerText()).includes("PAS-339"));
      assert((await page.locator("body").innerText()).toLowerCase().includes("not checked"));
      if (name === "desktop")
        assert((await page.locator("body").innerText()).toLowerCase().includes("not linked"));
      const connect = page.getByRole("button", { name: "Connect GitHub", exact: true });
      await connect.waitFor();
      await connect.focus();
      await page.keyboard.press("Enter");
      await page.getByText("@fixture-member connected", { exact: true }).waitFor();
      assert((await page.locator("body").innerText()).toLowerCase().includes("not checked"));
      await page.screenshot({ path: path.join(root, `${name}-github-linked.png`), fullPage: true });
      await page.getByRole("button", { name: "Use another GitHub account" }).click();
      await page.getByText("@fixture-member connected", { exact: true }).waitFor();
      await context.route("**/api/workspaces/member-github", (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({ status: 403, body: "{}" })
          : route.continue(),
      );
      await page.getByRole("button", { name: "Unlink GitHub" }).click();
      await page
        .getByText("GitHub could not be unlinked. Refresh the connection and try again.", {
          exact: true,
        })
        .waitFor();
      await context.unroute("**/api/workspaces/member-github");
      await page.getByRole("button", { name: "Refresh GitHub connection" }).click();
      await page.getByText("@fixture-member connected", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Unlink GitHub" }).click();
      await connect.waitFor();
      await context.route("**/api/workspaces/member-github", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 503, body: "{}" })
          : route.continue(),
      );
      await connect.click();
      await page.getByText("GitHub sign-in could not start. Try again.", { exact: true }).waitFor();
      await context.unroute("**/api/workspaces/member-github");
      await page.getByRole("button", { name: "Refresh GitHub connection" }).click();
      await connect.waitFor();
      if (name === "desktop")
        await page
          .getByText("Select your VM before signing in to Claude and Codex.", { exact: true })
          .waitFor();
      await page.request.post(`${manifest.origin}/__vm-fixture`);
      await page.reload();
      const vm = page.getByRole("combobox", { name: "Your paired VM" });
      await vm.waitFor();
      assert.equal(await vm.inputValue(), "");
      assert(await page.getByRole("button", { name: "Use this VM" }).isDisabled());
      await vm.selectOption({ label: "Member VM 1" });
      await context.route("**/api/workspaces/onboarding/vm", (route) =>
        route.fulfill({ status: 409, body: "{}" }),
      );
      await page.getByRole("button", { name: "Use this VM" }).click();
      await page
        .getByText("This VM could not be selected. Refresh the available VMs and choose again.", {
          exact: true,
        })
        .waitFor();
      await context.unroute("**/api/workspaces/onboarding/vm");
      await page.screenshot({ path: path.join(root, `${name}-vm-choice.png`), fullPage: true });
      await vm.selectOption({ label: "Member VM 1" });
      await page.getByRole("button", { name: "Use this VM" }).click();
      await page.getByText("Selected VM: Member VM 1", { exact: true }).waitFor();
      await page.reload();
      await page.getByText("Selected VM: Member VM 1", { exact: true }).waitFor();
      const accounts = page.getByRole("region", { name: "Your agent accounts" });
      await accounts.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture`);
      await page
        .getByRole("region", { name: "Private Claude sign-in" })
        .getByText("PRIVATE CLAUDE CHALLENGE", { exact: true })
        .waitFor();
      const broad = await (
        await page.request.get(
          `${manifest.origin}/api/workspaces/onboarding/agents?session=session&generation=0`,
        )
      ).text();
      assert(
        !broad.includes("PRIVATE") &&
          !broad.includes("terminal") &&
          !broad.includes("authorization"),
      );
      assert(!page.url().includes("PRIVATE"));
      assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("PRIVATE"));
      await page.getByLabel("Claude sign-in reply").fill("PRIVATE INPUT");
      await page.getByRole("button", { name: "Send reply", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
      await page
        .getByRole("region", { name: "Private Claude sign-in" })
        .waitFor({ state: "detached" });
      await accounts.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture?mode=failed`);
      await page
        .getByRole("region", { name: "Private Claude sign-in" })
        .waitFor({ state: "detached" });
      await accounts.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture?mode=expired`);
      await page
        .getByRole("region", { name: "Private Claude sign-in" })
        .waitFor({ state: "detached" });
      await accounts.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture`);
      await page.getByText("PRIVATE CLAUDE CHALLENGE", { exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__vm-fixture?mode=remove`);
      await page.reload();
      await vm.waitFor();
      assert.equal(await vm.inputValue(), "");
      await vm.selectOption({ label: "Member VM 2" });
      await page.getByRole("button", { name: "Use this VM" }).click();
      await page.getByText("Selected VM: Member VM 2", { exact: true }).waitFor();
      assert.equal(await page.getByText("PRIVATE CLAUDE CHALLENGE", { exact: true }).count(), 0);
      await accounts.getByRole("button", { name: "Sign in to Claude", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture?mode=connected`);
      await page
        .getByRole("region", { name: "Private Claude sign-in" })
        .waitFor({ state: "detached" });
      await accounts.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture`);
      const codex = page.getByRole("region", { name: "Private Codex sign-in" });
      await codex.getByText("PRIVATE DEVICE CODE ABCD-1234", { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(root, `${name}-private-code-light.png`),
        fullPage: true,
      });
      await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
      await page.screenshot({
        path: path.join(root, `${name}-private-code-dark.png`),
        fullPage: true,
      });
      await page.getByRole("combobox", { name: "Appearance" }).selectOption("light");
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await page.request.post(`${manifest.origin}/__agent-fixture?mode=connected`);
      await page.getByText("Both agent accounts are ready", { exact: true }).waitFor();
      const readiness = await (
        await page.request.get(
          `${manifest.origin}/api/workspaces/onboarding/agents?session=session&generation=0`,
        )
      ).json();
      assert.equal(readiness.ready, true);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, `${name}-light.png`), fullPage: true });
      await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
      await page.screenshot({ path: path.join(root, `${name}-dark.png`), fullPage: true });
      await page.reload();
      await page.getByRole("heading", { name: "Your VM", exact: true }).waitFor();
      await context.clearCookies();
      await page.reload();
      const signIn = page.getByRole("link", { name: "Sign in with Linear" });
      await signIn.waitFor();
      assert(!(await page.locator("body").innerText()).includes("PAS-339"));
      await signIn.click();
      await page.waitForURL(manifest.origin + manifest.page);
      await page.getByRole("heading", { name: "Your VM", exact: true }).waitFor();
      if (name === "desktop")
        fs.writeFileSync(path.join(root, "session.json"), JSON.stringify(await context.cookies()));
      await context.route("**/api/workspaces/onboarding?*", (route) =>
        route.fulfill({ status: 503, body: "{}" }),
      );
      await page.reload();
      await page.getByRole("button", { name: "Try again" }).waitFor();
      assert(!(await page.locator("body").innerText()).includes("PAS-339"));
      await context.unroute("**/api/workspaces/onboarding?*");
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
      observations.push({
        name,
        passed: true,
        realOAuthRedirect: name === "desktop",
        truthfulSteps: true,
        reloadPersists: true,
        noOverflow: true,
        outageClearsIssue: true,
        keyboardRetry: true,
        signedOutShellAndSafeReturn: true,
        privateAgentCodesRedactedFromBroadState: true,
        agentCancelFailureExpiryRetry: true,
        bothAgentsReady: true,
        vmChangeClearsPrivateChallenge: true,
        vmSelectionPersistsAndInvalidates: true,
        connectReconnectUnlink: true,
        linkedIdentityNotRepositoryPermission: true,
        failedStartRetry: true,
      });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
    fs.unlinkSync(path.join(root, "session.json"));
    console.log(JSON.stringify(observations));
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await exited;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
