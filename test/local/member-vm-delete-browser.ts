// Delete VM on the Runners page against a real Paws with the fake exe.dev client and bootstrap.
// Creates a VM to ready, opens Delete VM and its confirmation, finds a running task blocking the
// delete, forces it, waits for the VM and runner to go, then creates a VM with the same name.
// Usage: bun run build:status && bun --no-env-file test/local/member-vm-delete-browser.ts [evidence-directory]
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { chromium, type Browser } from "@playwright/test";

const repo = resolve(import.meta.dir, "../..");
const output = process.argv[2] ?? mkdtempSync(join(tmpdir(), "paws-member-vm-delete-browser-"));
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
    await page.getByRole("button", { name: "Add a host", exact: true }).waitFor();
  else await page.locator("[data-runner-row]").first().waitFor();
  return page;
}

type Snapshot = {
  vm: {
    vmName: string;
    step: string;
    runnerId: string | null;
    deleteStep: string | null;
    deleteFailure: string | null;
  }[];
  runners: { id: string; name: string; status: string }[];
  exeDev: string[];
  deleteVm: number;
};

const browser = await chromium.launch({ headless: true });
const fixture = startFixture("delete");
try {
  const manifest = await fixture.manifest;
  const page = await pageFor(browser, manifest, "member");
  const snapshot = async () => (await fixture.send("snapshot")).snapshot as Snapshot;

  await page.getByRole("button", { name: "Create VM", exact: true }).click();
  await page.locator("[data-member-vm]").waitFor();
  const deadline = Date.now() + STEP_WAIT_MS;
  while (Date.now() < deadline) {
    await fixture.send("heartbeat");
    if ((await page.locator('[data-member-vm="ready"]').count()) > 0) break;
    await page.waitForTimeout(250);
  }
  await page.locator('[data-member-vm="ready"]').waitFor();
  const created = await snapshot();
  const vmName = created.vm[0]!.vmName;
  observe("the VM is ready", vmName);

  const remove = page.locator("[data-member-vm] [data-vm-delete]");
  await remove.waitFor();
  await page.screenshot({ path: join(output, "01-delete-vm-button.png"), fullPage: true });
  observe("a ready VM shows Delete VM");

  await fixture.send("task");
  await remove.click();
  const dialog = page.getByRole("dialog", { name: `Delete VM ${vmName}?` });
  await dialog.waitFor();
  const text = await dialog.innerText();
  assert.match(text, /will be destroyed on exe\.dev/);
  assert.match(text, /runner removed from Paws/);
  await page.screenshot({ path: join(output, "02-delete-vm-confirm.png"), fullPage: true });
  observe("the confirmation names the VM, exe.dev and the runner", text);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await snapshot()).vm[0]!.deleteStep, null);
  observe("Cancel deletes nothing");

  await remove.click();
  await dialog.getByRole("button", { name: "Delete VM", exact: true }).click();
  const blocked = page.locator('[data-member-vm-delete="drain"] [data-vm-delete-blocked]');
  await blocked.waitFor({ timeout: STEP_WAIT_MS });
  assert.match(await blocked.innerText(), /PAS-901/);
  await page.screenshot({ path: join(output, "03-delete-blocked-by-task.png"), fullPage: true });
  const draining = await snapshot();
  assert.equal(draining.runners.find((runner) => runner.name === vmName)?.status, "draining");
  observe("a running task blocks the delete and is named; the runner is draining");

  await page.getByRole("button", { name: "Force delete" }).click();
  await page
    .getByRole("button", { name: "Create VM", exact: true })
    .waitFor({ timeout: STEP_WAIT_MS });
  const gone = await snapshot();
  assert.deepEqual(gone.vm, []);
  assert.equal(gone.deleteVm, 1);
  assert.equal(gone.exeDev.includes(vmName), false);
  assert.equal(gone.runners.find((runner) => runner.name === vmName)?.status, "revoked");
  await page.screenshot({ path: join(output, "04-deleted.png"), fullPage: true });
  observe("force delete stops the task, revokes the runner, destroys the VM and clears it", gone);

  await page.getByRole("button", { name: "Create VM", exact: true }).click();
  await page.locator("[data-member-vm]").waitFor();
  const again = await snapshot();
  assert.equal(again.vm[0]?.vmName, vmName);
  await page.screenshot({ path: join(output, "05-recreated.png"), fullPage: true });
  observe("Create VM after the delete reuses the name", again.vm[0]);
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(
    join(output, "observations.json"),
    JSON.stringify({ observations, errors }, null, 2),
  );
  await fixture.stop();
  await browser.close();
}
console.log(JSON.stringify({ output, observations: observations.length }));
