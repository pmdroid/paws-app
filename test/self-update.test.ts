import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  enqueueJob,
  getPawsUpdate,
  insertQueuedItem,
  migrate,
  openDatabase,
  requestPawsUpdateNow,
} from "../src/db";
import {
  createPawsUpdater,
  FakeCheckout,
  gitCheckout,
  handlePawsUpdateRequest,
  UpdateStepError,
} from "../src/self-update";
import { createLiveStatusProvider } from "../src/web";

function harness(options: { automatic?: boolean } = {}) {
  const clock = new FakeClock(1_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const checkout = new FakeCheckout("a1", "a1", ["a1"]);
  let restarts = 0;
  const updater = createPawsUpdater({
    db,
    checkout,
    now: () => clock.now(),
    automatic: () => options.automatic ?? true,
    restart: () => {
      restarts += 1;
    },
  });
  return { clock, db, checkout, updater, restarts: () => restarts };
}

function startJob(db: ReturnType<typeof openDatabase>, itemId: string, now: number) {
  return enqueueJob(db, { queue: JOB_KIND.start, payload: { itemId }, now });
}

describe("Paws update", () => {
  test("a new main commit schedules an update, and no new item.start job is claimed while it waits", async () => {
    const { db, clock, checkout, updater } = harness();
    expect(await updater.check("automatic")).toBeNull();

    const item = insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    startJob(db, item.id, clock.now());
    checkout.main = "b2";
    expect(await updater.check("automatic")).toMatchObject({
      target: "b2",
      current: "a1",
      status: "waiting",
      source: "automatic",
    });
    expect(claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.start] })).toBeNull();

    // Cancel drops the update, and the queued start runs again.
    const request = new Request("http://paws.test/api/paws-update", {
      method: "POST",
      body: JSON.stringify({ action: "cancel" }),
    });
    expect((await handlePawsUpdateRequest(request, "owner", db, () => clock.now()))?.status).toBe(
      200,
    );
    expect(getPawsUpdate(db)).toBeNull();
    expect(claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.start] })).not.toBeNull();
  });

  test("the workspace setting turns the automatic check off; a manual check still schedules", async () => {
    const { checkout, updater } = harness({ automatic: false });
    checkout.main = "b2";
    expect(await updater.check("automatic")).toBeNull();
    expect(await updater.check("manual")).toMatchObject({ target: "b2", source: "manual" });
  });

  test("main that does not contain the running commit is not an update", async () => {
    const { checkout, updater } = harness();
    checkout.history.splice(0, checkout.history.length, "b2", "a1");
    checkout.main = "b2";
    expect(await updater.check("automatic")).toBeNull();
  });

  test("running work finishes before the restart; questions and the merge queue do not hold it", async () => {
    const { db, clock, checkout, updater, restarts } = harness();
    const working = insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    beginImplementRun(db, working.id, clock.now());
    const asking = insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    beginImplementRun(db, asking.id, clock.now());
    applyWorkItemEvent(db, asking.id, "blocking_question");
    checkout.main = "b2";
    await updater.check("automatic");

    expect(await updater.tick()).toBe("waiting");
    clock.advance(60_000);
    applyWorkItemEvent(db, working.id, "turn_ended");
    expect(await updater.tick()).toBe("waiting");
    expect(checkout.applied).toEqual([]);

    applyWorkItemEvent(db, working.id, "closeout_accepted");
    expect(await updater.tick()).toBe("applied");
    expect(checkout.applied).toEqual(["b2"]);
    expect(checkout.current).toBe("b2");
    expect(restarts()).toBe(1);
    expect(getPawsUpdate(db)?.status).toBe("applying");

    // The new process sees its own commit and finishes the update.
    await updater.startup();
    expect(getPawsUpdate(db)).toBeNull();
  });

  test("an install failure keeps the old code, reports why, and stops draining", async () => {
    const { db, clock, checkout, updater, restarts } = harness();
    const item = insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    startJob(db, item.id, clock.now());
    checkout.main = "b2";
    checkout.failStep = "install";
    await updater.check("automatic");

    expect(await updater.tick()).toBe("failed");
    expect(checkout.current).toBe("a1");
    expect(restarts()).toBe(0);
    expect(getPawsUpdate(db)).toMatchObject({
      status: "failed",
      target: "b2",
      error: "bun install failed: install broke",
    });
    expect(claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.start] })).not.toBeNull();

    // The automatic check does not retry a broken commit; `paws update` does.
    expect(await updater.check("automatic")).toMatchObject({ status: "failed" });
    checkout.failStep = null;
    expect(await updater.check("manual")).toMatchObject({ status: "waiting" });
    expect(await updater.tick()).toBe("applied");
  });

  test("Update now applies at once while work is still running", async () => {
    const { db, clock, checkout, updater, restarts } = harness();
    const item = insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    checkout.main = "b2";
    await updater.check("automatic");
    expect(await updater.tick()).toBe("waiting");

    const request = (role: string) =>
      handlePawsUpdateRequest(
        new Request("http://paws.test/api/paws-update", {
          method: "POST",
          body: JSON.stringify({ action: "now" }),
        }),
        role,
        db,
        () => clock.now(),
      );
    expect((await request("member"))?.status).toBe(403);
    expect((await request("admin"))?.status).toBe(200);
    expect(await updater.tick()).toBe("applied");
    expect(restarts()).toBe(1);
  });

  test("a restart that did not reach the new commit marks the update failed", async () => {
    const { db, clock, checkout, updater } = harness();
    checkout.main = "b2";
    await updater.check("manual");
    requestPawsUpdateNow(db, clock.now());
    checkout.failStep = "checkout";
    db.run("UPDATE paws_update SET status = 'applying'");
    await updater.startup();
    expect(getPawsUpdate(db)).toMatchObject({
      status: "failed",
      error: "Paws restarted before the update finished.",
    });
  });
});

test("the live status snapshot shows the waiting update and the work it waits for", async () => {
  const { db, clock, checkout, updater } = harness();
  const item = insertQueuedItem(db, {
    id: "eng-102",
    title: "CSV / JSON formatters",
    now: clock.now(),
  });
  beginImplementRun(db, item.id, clock.now());
  applyWorkItemEvent(db, item.id, "turn_ended");
  checkout.main = "b8395a6f";
  await updater.check("automatic");
  expect(createLiveStatusProvider(db).snapshot().update).toEqual({
    target: "b8395a6f",
    current: "a1",
    status: "waiting",
    nowRequested: false,
    error: null,
    waitingFor: 1,
    holding: [{ id: "eng-102", title: "CSV / JSON formatters", phase: "closeout" }],
  });
});

describe("git checkout", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  function repos() {
    const origin = mkdtempSync(join(tmpdir(), "paws-update-origin-"));
    const app = mkdtempSync(join(tmpdir(), "paws-update-app-"));
    dirs.push(origin, app);
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.email", "test@paws.invalid");
    git(origin, "config", "user.name", "Paws Test");
    writeFileSync(join(origin, "README.md"), "one\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "one");
    git(app, "clone", "-q", origin, ".");
    writeFileSync(join(origin, "README.md"), "two\n");
    git(origin, "commit", "-q", "-am", "two");
    return { origin, app, next: git(origin, "rev-parse", "HEAD") };
  }

  /** Real git, fake bun: `failing` names the bun script that exits 1. */
  function checkoutWith(app: string, failing: string | null) {
    return gitCheckout(app, {
      bun: "bun",
      run: async (argv, cwd) => {
        if (argv[0] === "bun")
          return argv.includes(failing ?? "-")
            ? { code: 1, output: `error: ${failing} broke` }
            : { code: 0, output: "" };
        const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
        return {
          code: result.exitCode,
          output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
        };
      },
    })!;
  }

  test("fetches main, fast-forwards, installs and builds", async () => {
    const { app, next } = repos();
    const checkout = checkoutWith(app, null);
    const before = await checkout.head();
    expect(await checkout.fetchMain()).toBe(next);
    expect(await checkout.contains(next, before)).toBe(true);
    await checkout.apply(next);
    expect(await checkout.head()).toBe(next);
  });

  test("a failed install returns to the previous commit", async () => {
    const { app, next } = repos();
    const checkout = checkoutWith(app, "install");
    const before = await checkout.head();
    await checkout.fetchMain();
    const failure = await checkout.apply(next).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UpdateStepError);
    expect((failure as UpdateStepError).step).toBe("install");
    expect(await checkout.head()).toBe(before);
  });

  test("a directory that is not a git checkout cannot update itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-update-none-"));
    dirs.push(dir);
    expect(gitCheckout(dir)).toBeNull();
  });
});
