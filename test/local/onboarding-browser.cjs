const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const STEPS = {
  create: "Create your VM on exe.dev",
  install: "Install tools and the Paws runner",
  pair: "Pair the runner with Paws",
  health: "Check host health",
};
const WAITING_FOR_VM = "Once your VM is ready, sign in to Claude and Codex.";

(async () => {
  const root = process.argv[2],
    bun = process.argv[3];
  const child = spawn(bun, ["--no-env-file", "test/local/onboarding.ts", root], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let browser, activePage;
  const observations = [],
    errors = [];
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
    if (manifest.provisioning !== "wired")
      throw Error("The backend provisioning constructor is not wired into the onboarding fixture.");
    const post = async (route) => {
      const response = await fetch(manifest.origin + route, { method: "POST" });
      const body = await response.text();
      assert(response.ok, `${route}: ${response.status} ${body}`);
      return JSON.parse(body);
    };
    const provider = async () => (await fetch(`${manifest.origin}/__exe-fixture`)).json();
    async function waitForPolicy(repositories) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = await provider();
        const latest = state.repositoryPolicies.at(-1);
        if (latest && JSON.stringify(latest.repositories) === JSON.stringify(repositories))
          return latest;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`Guest policy did not apply ${JSON.stringify(repositories)}`);
    }
    async function publishPolicy(document) {
      const response = await fetch(`${manifest.origin}/__policy-fixture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(document),
      });
      assert(response.ok);
      return response.json();
    }
    const query = (assignment) => {
      const [, , , session, generation] = assignment.page.split("/");
      return `session=${session}&generation=${generation}`;
    };
    browser = await chromium.launch({ headless: true });
    async function open(width, height) {
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
          const linear = new URL(response.headers().location);
          const callback = new URL("/auth/linear/callback", manifest.origin);
          callback.searchParams.set("state", linear.searchParams.get("state"));
          callback.searchParams.set("code", "member");
          return route.fulfill({
            response,
            headers: { ...response.headers(), location: callback.href },
          });
        }
        return route.continue();
      });
      return context;
    }
    async function visit(context, url) {
      const page = await context.newPage();
      activePage = page;
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.text().includes("PRIVATE")) errors.push("Private text appeared in console");
      });
      await page.goto(manifest.origin + url);
      return page;
    }
    async function signIn(context, assignment) {
      const page = await visit(context, assignment.assignment);
      await page.waitForURL(manifest.origin + assignment.page);
      await page.getByRole("heading", { name: "GitHub", exact: true }).waitFor();
      return page;
    }
    function step(page, name, state, timeout) {
      return page
        .getByRole("list", { name: "VM setup progress" })
        .getByRole("listitem")
        .filter({ hasText: STEPS[name] })
        .getByText(state, { exact: true })
        .waitFor(timeout ? { timeout } : undefined);
    }
    async function agentsHidden(page) {
      await page.getByText(WAITING_FOR_VM, { exact: true }).waitFor();
      assert.equal(await page.getByRole("region", { name: "Your agent accounts" }).count(), 0);
      assert.equal(
        await page.getByRole("button", { name: /^(Sign in to|Open) (Claude|Codex)/ }).count(),
        0,
      );
    }
    async function truthful(page, assignment) {
      const body = await page.locator("body").innerText();
      assert(!body.includes("%"), "Progress shows a percentage");
      assert(!body.includes("PRIVATE"), "Private provider output reached the page");
      assert(!/paired runner|keep my automatic vm|choose a runner/i.test(body), "Runner chooser");
      assert(!/onboarding is ready|all set|setup complete/i.test(body), "Claims onboarding ready");
      assert.equal(await page.getByRole("combobox").count(), 1);
      const broad = await (
        await page.request.get(`${manifest.origin}/api/workspaces/onboarding?${query(assignment)}`)
      ).text();
      assert(!broad.includes("PRIVATE") && !broad.includes("ghp_"), "Private text in projection");
      for (const retired of ["selectedRunner", "runners", "source", "choice_required"])
        assert(!broad.includes(`"${retired}"`), `Retired projection field ${retired}`);
    }
    async function github(page) {
      assert((await page.locator("body").innerText()).toLowerCase().includes("not checked"));
      const connect = page.getByRole("button", { name: "Connect GitHub", exact: true });
      if (await page.getByRole("button", { name: "Unlink GitHub", exact: true }).count())
        await page.getByRole("button", { name: "Unlink GitHub", exact: true }).click();
      await connect.waitFor();
      await connect.focus();
      await page.keyboard.press("Enter");
      await page.getByText("@fixture-member connected", { exact: true }).waitFor();
      assert((await page.locator("body").innerText()).toLowerCase().includes("not checked"));
      await page.getByRole("button", { name: "Use another GitHub account" }).click();
      await page.getByText("@fixture-member connected", { exact: true }).waitFor();
      const context = page.context();
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
    }
    async function agents(page, assignment) {
      const context = page.context();
      const accounts = page.getByRole("region", { name: "Your agent accounts" });
      const claude = accounts.getByRole("button", {
        name: /^(Sign in to Claude|Open Claude sign-in)$/,
      });
      const privateClaude = page.getByRole("region", { name: "Private Claude sign-in" });
      await context.route("**/api/workspaces/onboarding/agents?*", (route) =>
        route.fulfill({ status: 503, body: "{}" }),
      );
      await page.reload();
      await accounts.getByText("Agent readiness is unavailable", { exact: true }).waitFor();
      assert.equal(
        await accounts
          .getByText("Both Claude and Codex must be connected", { exact: true })
          .count(),
        0,
      );
      await context.unroute("**/api/workspaces/onboarding/agents?*");
      await accounts.getByRole("button", { name: "Refresh agent accounts" }).click();
      await accounts
        .getByText("Both Claude and Codex must be connected", { exact: true })
        .waitFor();
      await claude.click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await post("/__agent-fixture");
      await privateClaude.getByText("PRIVATE CLAUDE CHALLENGE", { exact: true }).waitFor();
      const broad = await (
        await page.request.get(
          `${manifest.origin}/api/workspaces/onboarding/agents?${query(assignment)}`,
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
      await privateClaude.waitFor({ state: "detached" });
      for (const mode of ["failed", "expired"]) {
        await claude.click();
        await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
        await post(`/__agent-fixture?mode=${mode}`);
        await privateClaude.waitFor({ state: "detached" });
      }
      await claude.click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await post("/__agent-fixture");
      await privateClaude.getByText("PRIVATE CLAUDE CHALLENGE", { exact: true }).waitFor();
      const beforeLoss = await provider();
      await post("/__provisioning-fixture?step=health-fail");
      await accounts.waitFor({ state: "detached" });
      await step(page, "health", "In progress");
      for (const name of ["create", "install", "pair"]) await step(page, name, "Done");
      const retryHealth = page.getByRole("button", { name: "Retry health check", exact: true });
      assert.equal(await retryHealth.count(), 0);
      assert.equal(await page.getByText("PRIVATE CLAUDE CHALLENGE").count(), 0);
      await agentsHidden(page);
      await truthful(page, assignment);
      await post("/__provisioning-fixture?step=health");
      await step(page, "health", "Done");
      await accounts.waitFor();
      assert.equal(await retryHealth.count(), 0);
      assert.equal(await page.getByText("PRIVATE CLAUDE CHALLENGE").count(), 0);
      const afterLoss = await provider();
      assert.equal(afterLoss.creates, beforeLoss.creates);
      assert.deepEqual(afterLoss.vms, beforeLoss.vms);
      assert.equal(afterLoss.installs, beforeLoss.installs);
      assert.equal(afterLoss.pairRequests, beforeLoss.pairRequests);
      assert.deepEqual(afterLoss.repositoryPolicies, beforeLoss.repositoryPolicies);
      assert.deepEqual(afterLoss.guestVms, beforeLoss.guestVms);
      await claude.click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await post("/__agent-fixture?mode=connected");
      await privateClaude.waitFor({ state: "detached" });
      await accounts.getByRole("button", { name: "Sign in to Codex", exact: true }).click();
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      await post("/__agent-fixture");
      await page
        .getByRole("region", { name: "Private Codex sign-in" })
        .getByText("PRIVATE DEVICE CODE ABCD-1234", { exact: true })
        .waitFor();
      await post("/__agent-fixture?mode=connected");
      await accounts.getByText("Both agent accounts are ready", { exact: true }).waitFor();
    }
    async function themes(page, name) {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, `${name}-light.png`), fullPage: true });
      await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
      await page.screenshot({ path: path.join(root, `${name}-dark.png`), fullPage: true });
      await page.getByRole("combobox", { name: "Appearance" }).selectOption("light");
    }

    {
      const context = await open(1440, 1000);
      let page = await signIn(context, manifest.first);
      assert((await page.locator("body").innerText()).includes("PAS-339"));
      await step(page, "create", "In progress");
      for (const name of ["install", "pair", "health"]) await step(page, name, "Not started");
      await agentsHidden(page);
      await truthful(page, manifest.first);
      await page.screenshot({
        path: path.join(root, "desktop-create-running.png"),
        fullPage: true,
      });
      await github(page);
      const removed = await page.request.get(
        `${manifest.origin}/api/workspaces/onboarding/vm?${query(manifest.first)}`,
      );
      assert.equal(removed.status(), 404);
      await post("/__exe-fixture?mode=created");
      await page.getByText("Waiting for your VM to boot.", { exact: true }).waitFor();
      await step(page, "create", "Done");
      for (const name of ["install", "pair", "health"]) await step(page, name, "Not started");
      assert.equal((await provider()).installs, 0);
      await agentsHidden(page);
      await truthful(page, manifest.first);
      await page.screenshot({ path: path.join(root, "desktop-vm-booting.png"), fullPage: true });
      await page.close();
      await post("/__exe-fixture?mode=running");
      await post("/__provisioning-fixture?step=install-fail");
      page = await visit(context, manifest.first.page);
      await step(page, "create", "Done");
      await step(page, "install", "Failed");
      const retry = page.getByRole("button", { name: "Retry install", exact: true });
      await retry.waitFor();
      await agentsHidden(page);
      await truthful(page, manifest.first);
      const created = await provider();
      assert.equal(created.creates, 1);
      assert.equal(created.vms.length, 1);
      await page.getByText(`VM ${created.vms[0]}`, { exact: true }).waitFor();
      await themes(page, "desktop-install-failed");
      await context.route("**/api/workspaces/onboarding/vm/retry", (route) =>
        route.fulfill({ status: 409, body: "{}" }),
      );
      await retry.click();
      await page
        .getByText("Paws could not retry this step. Refresh onboarding and try again.", {
          exact: true,
        })
        .waitFor();
      await context.unroute("**/api/workspaces/onboarding/vm/retry");
      await retry.focus();
      await page.keyboard.press("Enter");
      await step(page, "install", "In progress");
      await post("/__provisioning-fixture?step=install-ok");
      await step(page, "install", "Done");
      const retried = await provider();
      assert.equal(retried.creates, 1);
      assert.equal(retried.installs, 2);
      assert.deepEqual(retried.vms, created.vms);
      assert.deepEqual(retried.guestVms, created.vms);
      await agentsHidden(page);
      await post("/__provisioning-fixture?step=pair");
      await step(page, "pair", "Done");
      await agentsHidden(page);
      const repository = "/__provisioning-fixture?step=repository&repository=fixture-org/app";
      assert.equal((await post(repository)).allowed, false);
      assert.deepEqual((await provider()).repositoryPolicies, []);
      await post("/__provisioning-fixture?step=health");
      await step(page, "health", "Done");
      await page.getByRole("region", { name: "Your agent accounts" }).waitFor();
      const initialPolicy = await waitForPolicy([]);
      assert.equal(initialPolicy.vm, created.vms[0]);
      assert.equal(initialPolicy.revision, 0);
      assert(initialPolicy.fence > 0);
      assert.equal((await post(repository)).allowed, false);
      const preparedWithoutLink = await post(`${repository}&prepare=true`);
      assert.equal(preparedWithoutLink.prepared.state, "prepared");
      assert.equal(preparedWithoutLink.linked, false);
      assert.equal(preparedWithoutLink.allowed, false);
      await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
      await page.getByText("@fixture-member connected", { exact: true }).waitFor();
      assert.equal((await post(`${repository}&generation=99`)).allowed, false);
      const queuedPolicy = await post(repository);
      assert.equal(queuedPolicy.linked, true);
      assert.equal(queuedPolicy.allowed, false);
      assert(queuedPolicy.policy.policyRevision > queuedPolicy.policy.policyAppliedRevision);
      const appliedPolicy = await waitForPolicy(["fixture-org/app"]);
      assert(appliedPolicy.revision > initialPolicy.revision);
      assert(appliedPolicy.fence > initialPolicy.fence);
      assert.equal((await post(repository)).allowed, true);
      assert.equal((await publishPolicy(initialPolicy)).accepted, false);
      assert.equal(
        (await publishPolicy({ ...appliedPolicy, repositories: ["fixture-org/other"] })).accepted,
        false,
      );
      assert.equal((await publishPolicy(appliedPolicy)).accepted, true);
      const policyState = await provider();
      assert(policyState.policyJobs.some((job) => job.recurring_every_ms > 0));
      assert.equal(policyState.repositoryPolicyCalls.filter((call) => !call.accepted).length, 2);
      assert.equal((await post(`${repository}&authorized=false`)).allowed, false);
      const withdrawnPolicy = await waitForPolicy([]);
      assert(withdrawnPolicy.revision > appliedPolicy.revision);
      assert.equal((await post(repository)).allowed, false);
      await waitForPolicy(["fixture-org/app"]);
      assert.equal((await post(repository)).allowed, true);
      fs.writeFileSync(
        path.join(root, "repository-policy-observations.json"),
        JSON.stringify(
          {
            initialPolicy,
            preparedWithoutLink,
            queuedPolicy,
            appliedPolicy,
            withdrawnPolicy,
            state: await provider(),
          },
          null,
          2,
        ),
      );
      await truthful(page, manifest.first);
      await agents(page, manifest.first);
      await truthful(page, manifest.first);
      await themes(page, "desktop-ready");
      await context.route("**/api/workspaces/onboarding?*", (route) =>
        route.fulfill({ status: 503, body: "{}" }),
      );
      await page.getByRole("button", { name: "Try again" }).waitFor();
      assert.equal(await page.getByRole("region", { name: "Your agent accounts" }).count(), 0);
      assert(!(await page.locator("body").innerText()).includes("PAS-339"));
      await context.unroute("**/api/workspaces/onboarding?*");
      await page.getByRole("button", { name: "Try again" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("region", { name: "Your agent accounts" }).waitFor();
      await context.clearCookies();
      await page.reload();
      const signInLink = page.getByRole("link", { name: "Sign in with Linear" });
      await signInLink.waitFor();
      assert(!(await page.locator("body").innerText()).includes("PAS-339"));
      await signInLink.click();
      await page.waitForURL(manifest.origin + manifest.first.page);
      await step(page, "health", "Done");
      observations.push({
        name: "desktop",
        automaticCreateStartsAfterAssignment: true,
        bootWaitShownBeforeInstall: true,
        removedVmReadReturns404: true,
        repositoryPolicyAppliedOnlyAfterReady: true,
        initialEmptyRepositoryPolicy: initialPolicy,
        repositoryGrantRequiresPreparationAndLinkedGitHub: true,
        staleAssignmentCannotGrantRepository: true,
        repositoryPolicyAppliedByRecurringJob: true,
        repositoryPolicyRejectsStaleAndConflictingWrites: true,
        repositoryPolicyExactReplayAccepted: true,
        repositoryPolicyWithdrawalAndRenewalApplied: true,
        serverProjectedSteps: true,
        provisioningContinuesWithPageClosed: true,
        installFailureRetriesSameVm: true,
        retryConflictRecovers: true,
        health: manifest.health,
        authenticatedHeartbeatProof: false,
        agentsWaitForSimulatedHealth: true,
        simulatedHeartbeatLossClearsPrivateSignIn: true,
        simulatedHeartbeatLossWaitsWithoutRetry: true,
        simulatedHeartbeatLossKeepsVmInstallAndPairing: true,
        privateTextStaysOutOfBroadState: true,
        pollingFailureClearsReady: true,
        keyboardRetry: true,
        signedOutShellAndSafeReturn: true,
        connectReconnectUnlink: true,
        noRunnerChooser: true,
      });
      await context.close();
    }

    {
      const context = await open(390, 844);
      const page = await signIn(context, manifest.returning);
      assert((await page.locator("body").innerText()).includes("PAS-340"));
      const { vms } = await provider();
      await page.getByText(`VM ${vms[0]}`, { exact: true }).waitFor();
      await page.getByText("reused from your earlier setup").waitFor();
      for (const name of ["create", "install", "pair"]) await step(page, name, "Done");
      const healthy = await step(page, "health", "Done", 5000).then(
        () => true,
        () => false,
      );
      if (!healthy) {
        await agentsHidden(page);
        await post("/__provisioning-fixture?step=health");
        await step(page, "health", "Done");
      }
      const reused = await provider();
      assert.equal(reused.creates, 1);
      assert.deepEqual(reused.vms, vms);
      const accounts = page.getByRole("region", { name: "Your agent accounts" });
      await accounts.getByText("Both agent accounts are ready", { exact: true }).waitFor();
      await truthful(page, manifest.returning);
      await themes(page, "mobile-reused");
      await github(page);
      await page.reload();
      await page.getByText("reused from your earlier setup").waitFor();
      observations.push({
        name: "mobile",
        returningMemberReusesVm: true,
        noSecondCreate: true,
        agentsOnReusedVm: true,
        noOverflow: true,
        connectReconnectUnlink: true,
        noRunnerChooser: true,
      });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(JSON.stringify(observations));
  } catch (error) {
    fs.writeFileSync(
      path.join(root, "failure.json"),
      JSON.stringify({ error: String(error), stack: error.stack, observations, errors }, null, 2),
    );
    if (activePage && !activePage.isClosed()) {
      await activePage.screenshot({ path: path.join(root, "failure.png"), fullPage: true });
      fs.writeFileSync(
        path.join(root, "failure-page.txt"),
        await activePage.locator("body").innerText(),
      );
    }
    throw error;
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await exited;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
