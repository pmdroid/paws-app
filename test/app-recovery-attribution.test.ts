import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, ensureBareMirror, git, worktreePath } from "../src/acp";
import { FakeClock, JOB_KIND, LONG_SLEEP_MS } from "../src/core";
import {
  beginImplementRun,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  applyWorkItemEvent,
} from "../src/db";
import { startPaws, type StartOptions } from "../src/index";

for (const state of [
  "running",
  "verifying",
  "recovering",
  "merge_queue",
  "paused",
  "awaiting_input",
] as const) {
  test(`legacy App ${state} work cannot enqueue fresh-main recovery without attribution`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "paws-app-recovery-")));
    const home = join(root, "home");
    mkdirSync(join(home, ".kyotoagent"), { recursive: true });
    expect(realpathSync(home)).toBe(home);
    expect(realpathSync(join(home, ".kyotoagent"))).toBe(join(home, ".kyotoagent"));
    const pawsHome = join(home, ".paws");
    mkdirSync(pawsHome);
    writeFileSync(join(pawsHome, "config.toml"), '[github]\nauth = "app"\nrepo = "acme/demo"\n');
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      KYOTOAGENT_ROOT: join(home, ".kyotoagent"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const source = join(root, "source");
    await git(["init", "-b", "main", source], { env });
    writeFileSync(join(source, "base"), "ancestor");
    await git(["-C", source, "add", "."], { env });
    await git(
      [
        "-C",
        source,
        "-c",
        "user.name=Ancestor",
        "-c",
        "user.email=ancestor@example.invalid",
        "commit",
        "-m",
        "base",
      ],
      { env },
    );
    await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot: pawsHome });
    await createWorktree({ owner: "acme", repo: "demo", itemId: "legacy", pawsRoot: pawsHome });
    const tree = worktreePath(pawsHome, "legacy");
    writeFileSync(join(tree, "dirty"), "preserve exact legacy WIP");
    const before = (await git(["-C", tree, "rev-parse", "HEAD"], { env })).trim();
    const clock = new FakeClock(Date.now());
    const options: StartOptions = { hostClock: clock };
    const paws = startPaws(
      { PAWS_HOME: pawsHome, PAWS_PORT: "0", PAWS_HOST: "127.0.0.1", PAWS_NO_TUNNEL: "1" },
      options,
    );
    try {
      insertQueuedItem(paws.db, { id: "legacy", branchName: "paws/legacy", now: clock.now() });
      const { run } = beginImplementRun(paws.db, "legacy", clock.now(), {
        phase: "running",
        wipCommit: before,
        baseSha: before,
      });
      for (const event of state === "paused"
        ? (["pause"] as const)
        : state === "awaiting_input"
          ? (["blocking_question"] as const)
          : state === "recovering"
            ? (["lease_expired"] as const)
            : state === "verifying"
              ? (["turn_ended"] as const)
              : state === "merge_queue"
                ? (["turn_ended", "closeout_accepted"] as const)
                : [])
        applyWorkItemEvent(paws.db, "legacy", event);
      clock.sleep(LONG_SLEEP_MS + 1);
      for (let i = 0; i < 100 && paws.db.query("SELECT 1 FROM wake").get() === null; i++)
        await Bun.sleep(10);
      expect(paws.db.query("SELECT 1 FROM wake").get()).not.toBeNull();
      expect(
        listJobs(paws.db).some((job) => job.queue === JOB_KIND.start && job.status === "pending"),
      ).toBe(false);
      expect(getWorkItem(paws.db, "legacy")?.state).toBe(
        state === "paused" || state === "awaiting_input" ? state : "failed",
      );
      expect(getRun(paws.db, run.id)?.status).toBe("lost");
      expect(
        listOutbox(paws.db).some((row) =>
          JSON.stringify(row.payload).includes("valid GitHub App commit policy"),
        ),
      ).toBe(true);
      expect(
        listOutbox(paws.db).some((row) =>
          JSON.stringify(row.payload).includes("Restarting from fresh main"),
        ),
      ).toBe(false);
      expect((await git(["-C", tree, "rev-parse", "HEAD"], { env })).trim()).toBe(before);
      expect(readFileSync(join(tree, "dirty"), "utf8")).toBe("preserve exact legacy WIP");
    } finally {
      await paws.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
