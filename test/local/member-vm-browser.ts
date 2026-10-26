// Create VM on the Runners page against a real Paws with the fake exe.dev client and bootstrap.
// Drives create, an install failure, Retry and ready, then the owner row and agent sign-in, an
// observer's refusal, a Paws without an exe.dev token, and phone width.
// Usage: bun run build:status && bun --no-env-file test/local/member-vm-browser.ts [evidence-directory]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { chromium, type Browser, type Page } from "@playwright/test";

const repo = resolve(import.meta.dir, "../..");
const output = process.argv[2] ?? mkdtempSync(join(tmpdir(), "paws-member-vm-browser-"));
mkdirSync(output, { recursive: true });
const STEP_WAIT_MS = 45_000;

type Manifest = {
  origin: string;
  cookie: string;
  sessions: Record<"member" | "observer", string>;
  member: string;
};

function startFixture(name: string, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), `paws-member-vm-${name}-`));
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "test/fixtures/member-vm-instance.ts"],
    {
      cwd: repo,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        PAWS_VERIFY_ROOT: root,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-paws-verification-bus",
        ...env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const logs: string[] = [];
  const waiters: {
    matches: (value: Record<string, unknown>) => boolean;
    resolve: (v: unknown) => void;
  }[] = [];
  void (async () => {
    for await (const chunk of child.stderr) logs.push(new TextDecoder().decode(chunk));
  })();
  const lines = createInterface({ input: Readable.fromWeb(child.stdout as never) });
  lines.on("line", (line: string) => {
    logs.push(line);
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.find((entry) => entry.matches(value));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(value);
      }
    } catch {}
  });
  const read = <T>(matches: (value: Record<string, unknown>) => boolean) =>
    new Promise<T>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Fixture timeout:\n${logs.join("\n")}`)),
        30_000,
      );
      waiters.push({
        matches,
        resolve: (value) => {
          clearTimeout(timer);
          done(value as T);
        },
      });
    });
  const send = async (command: string) => {
    const reply = read(
      (value) => value.done === command || ("snapshot" in value && command === "snapshot"),
    );
    child.stdin.write(`${command}\n`);
    child.stdin.flush();
    return reply as Promise<Record<string, unknown>>;
  };
  return {
    root,
    logs,
    manifest: read<Manifest>((value) => typeof value.origin === "string"),
    send,
    async stop() {
      child.stdin.write("stop\n");
      child.stdin.end();
      await child.exited;
      writeFileSync(join(output, `${name}-fixture.log`), logs.join("\n"));
    },
  };
}

const errors: string[] = [];
const observations: { name: string; observed: unknown }[] = [];
const observe = (name: string, observed: unknown = true) => observations.push({ name, observed });

async function pageFor(browser: Browser, manifest: Manifest, identity: "member" | "observer") {
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
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(`${identity}: ${error.message}`));
  await page.goto(`${manifest.origin}/status/runners`);
  // Observers get the list without the member controls.
  if (identity === "member")
    await page.getByRole("button", { name: "Add a runner", exact: true }).waitFor();
  else await page.locator("[data-runner-row]").first().waitFor();
  return page;
}

async function phoneWidth(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  // The callbacks run in the page; this file type-checks without the DOM library.
  const overflow = await page.evaluate(() => {
    const view = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number } };
      innerWidth: number;
    };
    return view.document.documentElement.scrollWidth > view.innerWidth;
  });
  await page.screenshot({ path: join(output, `${name}-mobile.png`), fullPage: true });
  assert.equal(overflow, false, `${name} overflows at 390 px`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function call(page: Page, method: string, path: string) {
  return page.evaluate(
    async (input) =>
      (
        await fetch(input.path, {
          method: input.method,
          headers:
            input.method === "GET"
              ? {}
              : {
                  "content-type": "application/json",
                  "x-paws-csrf":
                    (
                      globalThis as unknown as {
                        document: {
                          querySelector(selector: string): {
                            getAttribute(name: string): string | null;
                          } | null;
                        };
                      }
                    ).document
                      .querySelector('meta[name="paws-csrf"]')
                      ?.getAttribute("content") ?? "",
                },
          ...(input.method === "GET" ? {} : { body: "{}" }),
        })
      ).status,
    { method, path },
  );
}

const step = (page: Page, name: string) => page.locator(`[data-vm-step="${name}"]`);

const browser = await chromium.launch({ headless: true });
const fixture = startFixture("fake");
const bare = startFixture("no-token", { PAWS_FIXTURE_NO_EXE_DEV: "1" });
try {
  const manifest = await fixture.manifest;
  const member = await pageFor(browser, manifest, "member");
  const create = member.getByRole("button", { name: "Create VM", exact: true });
  await create.waitFor();
  observe("a member sees Create VM when exe.dev is configured");

  await fixture.send("fail-install");
  const started = member.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runners/vm") && response.request().method() === "POST",
  );
  await create.click();
  const startedResponse = await started;
  assert.equal(startedResponse.status(), 200);
  assert.ok(startedResponse.request().headers()["x-paws-csrf"]);
  await member.locator("[data-member-vm]").waitFor();
  assert.equal(await member.locator("[data-vm-step]").count(), 4);
  assert.deepEqual(
    await member.locator("[data-vm-step] .runner-skill-name b, [data-vm-step] b").allTextContents(),
    ["Create the VM", "Install the runner", "Enroll with Paws", "First heartbeat"],
  );
  assert.equal(await create.count(), 0);
  await member.screenshot({ path: join(output, "started-desktop.png"), fullPage: true });
  observe("pressing Create VM shows the four steps and replaces the button");

  // The page polls; nothing reloads it from here on.
  await member
    .locator('[data-vm-step="install"][data-vm-state="failed"]')
    .waitFor({ timeout: STEP_WAIT_MS });
  await step(member, "install").getByText("the runner installer exited 1").waitFor();
  assert.equal(await step(member, "create").getAttribute("data-vm-state"), "done");
  assert.match(
    (await step(member, "create").locator("[data-vm-elapsed]").textContent()) ?? "",
    /\d/,
  );
  assert.match(
    (await step(member, "install").locator("[data-vm-elapsed]").textContent()) ?? "",
    /\d/,
  );
  await member.screenshot({ path: join(output, "failed-desktop.png"), fullPage: true });
  await phoneWidth(member, "failed");
  observe("a failed step shows the stored error and elapsed time without a reload");

  const retried = member.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runners/vm/retry") && response.request().method() === "POST",
  );
  await member.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal((await retried).status(), 200);
  await member
    .locator('[data-vm-step="health"][data-vm-state="running"]')
    .waitFor({ timeout: STEP_WAIT_MS });
  assert.equal(await step(member, "install").getAttribute("data-vm-state"), "done");
  assert.equal(await step(member, "enroll").getAttribute("data-vm-state"), "done");
  const midway = (await fixture.send("snapshot")).snapshot as {
    createVm: number;
    bootstrap: string[];
  };
  assert.equal(midway.createVm, 1, "retry resumed at install instead of creating the VM again");
  observe("Retry resumes from the failed step", midway);

  await fixture.send("heartbeat");
  await member.locator('[data-member-vm="ready"]').waitFor({ timeout: STEP_WAIT_MS });
  for (const name of ["create", "install", "enroll", "health"])
    assert.equal(await step(member, name).getAttribute("data-vm-state"), "done");
  const row = member.locator("[data-runner-row]").filter({ hasText: "ada-lovelace-paws" });
  await row.getByText("Owned by Ada Lovelace", { exact: false }).waitFor();
  await member.screenshot({ path: join(output, "ready-desktop.png"), fullPage: true });
  await phoneWidth(member, "ready");
  observe("once ready the runner row lists the member as owner");

  await member.getByRole("link", { name: "Open ada-lovelace-paws", exact: true }).click();
  await member.getByRole("button", { name: "Sign in to agents", exact: true }).waitFor();
  await member.screenshot({ path: join(output, "runner-detail-desktop.png"), fullPage: true });
  await phoneWidth(member, "runner-detail");
  observe("the runner detail view offers agent sign-in");

  await member.goto(`${manifest.origin}/status/runners`);
  await member.locator('[data-member-vm="ready"]').waitFor();
  assert.equal(await member.getByRole("button", { name: "Create VM", exact: true }).count(), 0);
  observe("a member who already has a VM sees its state instead of the button");

  const observer = await pageFor(browser, manifest, "observer");
  await observer.locator("[data-runner-row]").first().waitFor();
  assert.equal(await observer.getByRole("button", { name: "Create VM", exact: true }).count(), 0);
  assert.equal(await observer.locator("[data-member-vm]").count(), 0);
  const refused = {
    get: await call(observer, "GET", "/api/runners/vm"),
    start: await call(observer, "POST", "/api/runners/vm"),
    retry: await call(observer, "POST", "/api/runners/vm/retry"),
  };
  assert.deepEqual(refused, { get: 403, start: 403, retry: 403 });
  assert.equal(await call(member, "POST", "/api/runners/vm/retry"), 200);
  observe("an observer sees no button and every route refuses them", refused);

  const bareManifest = await bare.manifest;
  const noToken = await pageFor(browser, bareManifest, "member");
  await noToken.waitForTimeout(1_000);
  assert.equal(await noToken.getByRole("button", { name: "Create VM", exact: true }).count(), 0);
  const status = await noToken.evaluate(async () => {
    const response = await fetch("/api/runners/vm");
    return { status: response.status, body: await response.json() };
  });
  assert.deepEqual(status, { status: 200, body: { available: false } });
  await phoneWidth(noToken, "no-token");
  observe("without an exe.dev token the button is absent and the route says unavailable", status);

  assert.deepEqual(errors, []);
  writeFileSync(
    join(output, "observations.json"),
    JSON.stringify({ observations, errors }, null, 2),
  );
  console.log(`VERIFIED ${output}`);
} catch (error) {
  const snapshot = await Promise.race([
    fixture.send("snapshot"),
    new Promise((done) => setTimeout(() => done(null), 5_000)),
  ]);
  writeFileSync(
    join(output, "observations.json"),
    JSON.stringify({ observations, errors, snapshot }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await Promise.all([fixture.stop(), bare.stop()]);
}
