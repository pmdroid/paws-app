const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

(async () => {
  const bun = process.argv[2];
  assert(bun && path.isAbsolute(bun));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paws-runner-dashboard-"));
  const child = spawn(bun, ["--no-env-file", "test/fixtures/runner-dashboard-instance.ts"], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      PATH: path.dirname(bun) + ":/usr/bin:/bin",
      HOME: root,
      PAWS_VERIFY_ROOT: root,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const logs = [],
    waiters = [];
  child.stderr.on("data", (bytes) => logs.push(bytes.toString()));
  createInterface({ input: child.stdout }).on("line", (line) => {
    logs.push(line);
    try {
      const value = JSON.parse(line);
      const waiter = waiters.find((entry) => entry.matches(value));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(value);
      }
    } catch {}
  });
  const read = (matches) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fixture timeout: " + logs.join("\n"))),
        20000,
      );
      waiters.push({
        matches,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  const manifest = await read((value) => value.origin);
  const ca = fs.readFileSync(manifest.certPath);
  async function exchange(port, url, body, peer) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const request = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: url,
          ca,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          ...peer,
          method: bytes ? "POST" : "GET",
          headers: bytes
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(bytes) }
            : {},
        },
        (response) => {
          let value = "";
          response.on("data", (chunk) => (value += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(value) }),
          );
        },
      );
      request.setTimeout(10000, () => request.destroy(new Error("HTTPS timed out")));
      request.on("error", reject);
      request.end(bytes);
    });
  }
  const browser = await chromium.launch({
    headless: true,
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    },
  });
  const errors = [],
    external = [],
    actions = [],
    observations = [];
  const observe = (name, observed) => observations.push({ name, passed: true, observed });
  const port = Number(new URL(manifest.origin).port);
  async function pageFor(identity) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([
      {
        name: manifest.cookie,
        value: manifest.sessions[identity],
        url: manifest.origin,
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === manifest.origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("request", (request) => {
      if (request.url().includes("/api/runners") && request.method() === "POST")
        actions.push({
          path: new URL(request.url()).pathname,
          body: request.postData(),
          csrf: !!request.headers()["x-paws-csrf"],
        });
    });
    await page.goto(manifest.origin + "/status/#/runners");
    await page.getByRole("heading", { name: "Runners", exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh runners" }).waitFor({ state: "visible" });
    return page;
  }
  async function mutation(page, endpoint, payload, includeCsrf = true) {
    return page.evaluate(
      async (input) =>
        (
          await fetch(input.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(input.includeCsrf
                ? { "x-paws-csrf": document.querySelector('meta[name="paws-csrf"]').content }
                : {}),
            },
            body: JSON.stringify(input.payload),
          })
        ).status,
      { endpoint, payload, includeCsrf },
    );
  }
  async function submit(page, name, suffix, scope = page) {
    const response = page.waitForResponse(
      (r) => r.url().endsWith(suffix) && r.request().method() === "POST",
    );
    await scope.getByRole("button", { name, exact: true }).click();
    const value = await response;
    assert.equal(value.status(), 200);
    return value.json();
  }
  let peer;
  try {
    assert.equal((await exchange(port, "/api/runners")).status, 401);
    await assert.rejects(exchange(manifest.runnerPort, "/v1/commands"));
    const owner = await pageFor("owner");
    await owner.getByText("No runners are enrolled.", { exact: false }).waitFor();
    assert.deepEqual(await owner.locator("#side .nav").allTextContents(), [
      "Overview",
      "Runners",
      "Settings",
    ]);
    observe("normal authenticated dashboard has three areas and a real empty runner list", {
      anonymous: 401,
    });
    await owner.getByRole("button", { name: "Add a runner" }).click();
    await owner.getByRole("dialog", { name: "Add a runner" }).waitFor();
    await owner.getByRole("textbox", { name: "Runner name" }).fill("Linux proof host");
    const enrollment = await submit(owner, "Create command", "/enrollments");
    const claimed = await exchange(port, "/api/runner-enrollments", {
      token: enrollment.token,
      name: enrollment.name,
      csr: manifest.client.csr,
    });
    assert.equal(claimed.status, 200);
    await owner.getByRole("button", { name: "Close", exact: true }).click();
    await owner.getByRole("button", { name: "Refresh runners" }).click();
    peer = { cert: claimed.body.certificate, key: manifest.client.key };
    const runnerId = claimed.body.runnerId,
      healthPath = `/api/runners/${runnerId}/health`;
    observe("a workspace member enrolls the actual HTTPS host with a single-use token", {
      runnerId,
    });
    await owner.getByRole("button", { name: "View health" }).click();
    await owner.getByText("No health checks yet.", { exact: true }).waitFor();
    await owner.locator('select[name="agent"]').selectOption("codex");
    assert(
      await owner.evaluate(() => {
        const field = document.querySelector('input[name="model"]');
        field.value = "held-model";
        window.dispatchEvent(new Event("hashchange"));
        return (
          field === document.querySelector('input[name="model"]') && field.value === "held-model"
        );
      }),
    );
    await owner.getByLabel("Model, optional").fill("draft-model");
    await owner.getByLabel("Effort, optional").fill("draft-effort");
    const probe = await submit(owner, "Check connection", "/health");
    const commands = await exchange(manifest.runnerPort, "/v1/commands", undefined, peer);
    const envelope = commands.body.commands.find(
      (entry) => JSON.parse(Buffer.from(entry.payload, "base64url")).id === probe.commandId,
    );
    assert(envelope);
    assert.deepEqual(JSON.parse(Buffer.from(envelope.payload, "base64url")).profile, {
      agent: "codex",
      model: "draft-model",
      effort: "draft-effort",
    });
    assert(
      crypto.verify(
        null,
        Buffer.from(envelope.payload, "base64url"),
        crypto.createPublicKey(claimed.body.signingKeys[0].publicKeyPem),
        Buffer.from(envelope.signature, "base64url"),
      ),
    );
    const result = {
      executionId: manifest.executionIds[0],
      commandId: probe.commandId,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      models: [{ id: "scripted-model", name: "Scripted model" }],
    };
    assert.equal((await exchange(manifest.runnerPort, "/v1/health", result, peer)).status, 200);
    await owner.getByRole("button", { name: "Refresh runners" }).click();
    await owner.getByText("Connection complete", { exact: true }).waitFor();
    const login = await submit(owner, "Check sign-in", "/health");
    assert.equal(
      (
        await exchange(
          manifest.runnerPort,
          "/v1/health",
          {
            ...result,
            commandId: login.commandId,
            executionId: manifest.executionIds[1],
            login: { agent: "codex", authenticated: true, method: "subscription" },
          },
          peer,
        )
      ).status,
      200,
    );
    await owner.getByRole("button", { name: "Refresh runners" }).click();
    await owner.getByText("Signed in via subscription", { exact: true }).waitFor();
    observe("health controls issue signed commands and show actual persisted mTLS receipts", {
      retainedProfile: { agent: "codex", model: "draft-model", effort: "draft-effort" },
      probe: probe.commandId,
      login: login.commandId,
    });
    for (const [name, status] of [
      ["Pause", "paused"],
      ["Resume", "active"],
      ["Drain", "draining"],
      ["Resume", "active"],
    ]) {
      await submit(owner, name, "/status");
      await owner.locator(".runner-list .tag").filter({ hasText: status }).waitFor();
    }
    const before = actions.filter((action) => action.path.endsWith("/status")).length;
    await owner.locator('[data-runner-status="paused"]').evaluate((button) => {
      button.click();
      button.click();
    });
    await owner.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal(actions.filter((action) => action.path.endsWith("/status")).length, before + 1);
    await submit(owner, "Resume", "/status");
    observe("pause, resume and drain use real status changes and suppress duplicate clicks", {
      statusMutations: 6,
    });
    assert.equal(
      await mutation(owner, healthPath, { type: "login_check", agent: "codex" }, false),
      403,
    );
    const member = await pageFor("member");
    await member.locator(".runner-list h2").waitFor();
    assert.equal(await member.locator("[data-runner-status]").count(), 0);
    await member.getByRole("button", { name: "View health" }).click();
    await member.getByText("Signed in via subscription", { exact: true }).waitFor();
    assert.equal(await member.locator("#runner-health").count(), 0);
    assert.equal(await mutation(member, healthPath, { type: "login_check", agent: "codex" }), 403);
    const stale = await pageFor("stale");
    await stale.getByRole("button", { name: "Add a runner" }).waitFor();
    assert(await stale.getByRole("button", { name: "Add a runner" }).isEnabled());
    assert.equal(await stale.getByRole("link", { name: "Sign in again" }).count(), 0);
    observe(
      "persisted member role denies mutations, missing CSRF fails closed and an older administrator sign-in keeps its controls",
      { member: 403, csrf: 403, olderAdministratorControls: true },
    );
    await owner.screenshot({ path: path.join(root, "desktop.png"), fullPage: true });
    await member.setViewportSize({ width: 390, height: 844 });
    await member.waitForFunction(
      () => document.querySelector("#side").getBoundingClientRect().right <= 0,
    );
    assert(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await member.screenshot({ path: path.join(root, "mobile.png"), fullPage: true });
    await submit(owner, "Approve runner", "/approve");
    const originalRow = owner.locator(".runner-list > li").filter({ hasText: "Linux proof host" });
    const secondRow = owner.locator(".runner-list > li").filter({ hasText: "Pending proof host" });
    await owner.route("**/api/runners/*/health", (route) => route.abort());
    await originalRow.getByRole("button", { name: "View health" }).click();
    await owner.getByRole("alert").waitFor();
    assert.equal(await owner.getByText("Signed in via subscription", { exact: true }).count(), 1);
    await secondRow.getByRole("button", { name: "View health" }).click();
    await owner.getByRole("heading", { name: "Pending proof host health", exact: true }).waitFor();
    await owner.getByRole("alert").waitFor();
    assert.equal(await owner.getByText("Signed in via subscription", { exact: true }).count(), 0);
    assert.equal(await owner.getByText("Connection complete", { exact: true }).count(), 0);
    await owner.unroute("**/api/runners/*/health");
    await owner.getByRole("button", { name: "Refresh runners" }).click();
    await owner.getByText("No health checks yet.", { exact: true }).waitFor();
    await originalRow.getByRole("button", { name: "View health" }).click();
    await owner.getByText("Signed in via subscription", { exact: true }).waitFor();
    observe(
      "health failures preserve same-host receipts and never attribute them to another host",
      {
        sameHostRetained: true,
        changedHostCleared: true,
      },
    );
    await owner.route("**/api/runners", (route) => route.abort());
    await owner.getByRole("button", { name: "Refresh runners" }).click();
    await owner.getByRole("alert").waitFor();
    await owner.unroute("**/api/runners");
    await owner.getByRole("button", { name: "Refresh runners" }).click();
    await originalRow.locator('[data-runner-status="paused"]').waitFor();
    await owner.waitForFunction(() => !document.querySelector("[data-runners-refresh]").disabled);
    await originalRow.getByText("Revoke access", { exact: true }).click();
    await submit(owner, "Revoke runner", "/status", originalRow);
    await owner.locator(".runner-list .tag").filter({ hasText: "revoked" }).waitFor();
    let rejection;
    try {
      rejection = (await exchange(manifest.runnerPort, "/v1/commands", undefined, peer)).status;
    } catch (failure) {
      assert.equal(failure.code, "ECONNRESET");
      rejection = failure.code;
    }
    assert([403, "ECONNRESET"].includes(rejection));
    observe("network errors can be retried and revocation denies the former mTLS identity", {
      revoked: true,
      rejection,
      healthyControl: 200,
    });
    const pending = read((value) => value.snapshot);
    child.stdin.write("snapshot\n");
    const snapshot = (await pending).snapshot;
    assert.equal(snapshot.runners.find((runner) => runner.id === runnerId).status, "revoked");
    assert.equal(snapshot.commands.length, 2);
    assert.equal(
      snapshot.audit.filter((entry) =>
        ["runner.paused", "runner.active", "runner.draining", "runner.revoked"].includes(
          entry.action,
        ),
      ).length,
      7,
    );
    assert(
      actions.filter((action) => !action.csrf).length === 1 &&
        errors.length === 0 &&
        external.every((url) => url.startsWith("https://fonts.googleapis.com/")),
    );
    observe("browser actions are persisted, CSRF-bound and free of page errors or hosted calls", {
      commands: 2,
      statusAudits: 7,
    });
  } finally {
    await browser.close();
    child.stdin.end("stop\n");
    await new Promise((resolve) => child.once("exit", resolve));
    fs.writeFileSync(path.join(root, "fixture.log"), logs.join("\n"));
    fs.writeFileSync(
      path.join(root, "browser-proof.json"),
      JSON.stringify({ observations, errors, external, actions }, null, 2),
    );
    console.log("PAWS_RUNNER_DASHBOARD_PROOF " + root);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
