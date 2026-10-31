import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createWorktree, ensureBareMirror, git, removeWorktree, worktreePath } from "../acp";
import { WORK_ITEM_STATES } from "../core";
import { insertQueuedItem, insertRun, migrate, openDatabase, type WorkItemRecord } from "../db";
import { setJournalSink } from "../journal";
import { RETIRED_WORKTREE_MS, sweepWorktrees, type WorktreeSweep } from "./worktree-sweep";

const roots: string[] = [];
const repository = { owner: "acme", repo: "demo", remoteUrl: "" };
const now = Date.UTC(2026, 9, 17);
const old = now - RETIRED_WORKTREE_MS - 60_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("missing owners and probe worktrees are retained with one info notice per path", async () => {
  const fixture = await setup();
  await fixture.item("ENG-gone", "cancelled", old);
  fixture.db.run("DELETE FROM run WHERE item_id = 'ENG-gone'");
  fixture.db.run("DELETE FROM work_item WHERE id = 'ENG-gone'");
  await createWorktree({ ...repository, itemId: "probes-123", pawsRoot: fixture.pawsRoot });
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await sweepWorktrees(fixture.sweep());
    await sweepWorktrees(fixture.sweep());
    expect(existsSync(worktreePath(fixture.pawsRoot, "ENG-gone"))).toBe(true);
    expect(existsSync(worktreePath(fixture.pawsRoot, "probes-123"))).toBe(true);
    const notices = lines.map((line) => JSON.parse(line));
    expect(notices).toHaveLength(2);
    expect(
      notices.every((entry) => entry.level === "info" && entry.reason === "owner_missing"),
    ).toBe(true);
  } finally {
    restore();
  }
}, 30_000);

test("missing-owner notices are pruned when paths disappear and stay scoped to each root", async () => {
  const fixture = await setup();
  const key = "probes-notice";
  await createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await sweepWorktrees(fixture.sweep());
    await removeWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
    await sweepWorktrees(fixture.sweep());
    await createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
    await sweepWorktrees(fixture.sweep());
    const another = join(fixture.pawsRoot, "other-root");
    await mkdir(join(another, "worktrees", key), { recursive: true });
    await sweepWorktrees(fixture.sweep({ pawsRoot: another }));
    await sweepWorktrees(fixture.sweep());
    expect(lines.filter((line) => line.includes('"owner_missing"'))).toHaveLength(3);
  } finally {
    restore();
  }
}, 30_000);

test("only expired merged, cancelled and failed items are removed", async () => {
  const fixture = await setup();
  for (const state of WORK_ITEM_STATES) await fixture.item(`ENG-${state}`, state, old);
  await sweepWorktrees(fixture.sweep());
  for (const state of WORK_ITEM_STATES)
    expect(fixture.present()[`ENG-${state}`]).toBe(
      !["merged", "cancelled", "failed"].includes(state),
    );
}, 30_000);

test("terminal transition, run and directory activity each retain worktrees for seven days", async () => {
  const fixture = await setup();
  await fixture.item("ENG-cancel", "cancelled", old);
  await fixture.item("ENG-run", "failed", old);
  await fixture.item("ENG-files", "merged", now - 60_000);
  fixture.db.run(
    "INSERT INTO work_item_event (item_id, version, at, from_state, to_state, event) VALUES (?, 1, ?, 'running', 'cancelled', 'cancel')",
    ["ENG-cancel", now - 60_000],
  );
  insertRun(fixture.db, { itemId: "ENG-run", now: now - 60_000, status: "lost" });
  await sweepWorktrees(fixture.sweep());
  expect(fixture.present()).toEqual({ "ENG-cancel": true, "ENG-run": true, "ENG-files": true });
  await sweepWorktrees(fixture.sweep({ now: now + RETIRED_WORKTREE_MS }));
  expect(fixture.present()).toEqual({ "ENG-cancel": false, "ENG-run": false, "ENG-files": false });
}, 30_000);

test("expired terminal worktrees are force-removed including uncommitted files", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "failed", old);
  const path = worktreePath(fixture.pawsRoot, "ENG-1");
  await writeFile(join(path, "unfinished.txt"), "retired");
  await utimes(path, old / 1000, old / 1000);
  await sweepWorktrees(fixture.sweep());
  expect(fixture.present()["ENG-1"]).toBe(false);
}, 30_000);

test("ownership is case-sensitive and is never inferred from a branch or old identifier", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "cancelled", old);
  await fixture.item("ENG-2", "failed", old);
  const path = worktreePath(fixture.pawsRoot, "ENG-1");
  const lower = worktreePath(fixture.pawsRoot, "eng-1");
  await git(["-C", path, "worktree", "move", path, lower]);
  fixture.db.run("UPDATE work_item SET linear_identifier = 'MOVED-2' WHERE id = 'ENG-2'");
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await sweepWorktrees(fixture.sweep());
    expect(existsSync(lower)).toBe(true);
    expect(existsSync(worktreePath(fixture.pawsRoot, "ENG-2"))).toBe(true);
    expect(lines).toHaveLength(2);
  } finally {
    restore();
  }
}, 30_000);

test("a shared live or busy owner prevents removal", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "cancelled", old);
  await fixture.item("ENG-2", "failed", old);
  const sibling = insertQueuedItem(fixture.db, { id: "sibling" });
  fixture.db.run(
    "UPDATE work_item SET linear_identifier = 'ENG-1', state = 'running' WHERE id = ?",
    [sibling.id],
  );
  await sweepWorktrees(fixture.sweep({ busy: (id) => id === "ENG-2" }));
  expect(fixture.present()).toEqual({ "ENG-1": true, "ENG-2": true });
}, 30_000);

test("owners and expiry are rechecked before removal", async () => {
  const fixture = await setup();
  for (const id of ["ENG-state", "ENG-owner", "ENG-run"]) await fixture.item(id, "failed", old);
  await sweepWorktrees(
    fixture.sweep({
      hold: async (ids, operation) => {
        if (ids.includes("ENG-state"))
          fixture.db.run(
            "UPDATE work_item SET state = 'running', version = version + 1 WHERE id = 'ENG-state'",
          );
        if (ids.includes("ENG-owner")) {
          const sibling = insertQueuedItem(fixture.db, { id: "new-owner" });
          fixture.db.run("UPDATE work_item SET linear_identifier = 'ENG-owner' WHERE id = ?", [
            sibling.id,
          ]);
        }
        if (ids.includes("ENG-run"))
          insertRun(fixture.db, { itemId: "ENG-run", now, status: "lost" });
        await operation();
      },
    }),
  );
  expect(fixture.present()).toEqual({ "ENG-state": true, "ENG-owner": true, "ENG-run": true });
}, 30_000);

test("removal waits on the existing mirror lock and then rechecks the item", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "failed", old);
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const refresh = ensureBareMirror({
    ...repository,
    remoteUrl: fixture.source,
    pawsRoot: fixture.pawsRoot,
    networkGit: async (args) => {
      entered();
      await gate;
      return git(args);
    },
  });
  await reached;
  let held!: () => void;
  const holding = new Promise<void>((done) => {
    held = done;
  });
  const sweep = sweepWorktrees(
    fixture.sweep({
      hold: async (_ids, operation) => {
        held();
        await operation();
      },
    }),
  );
  try {
    await holding;
    fixture.db.run(
      "UPDATE work_item SET state = 'running', version = version + 1 WHERE id = 'ENG-1'",
    );
  } finally {
    release();
  }
  await Promise.all([refresh, sweep]);
  expect(fixture.present()["ENG-1"]).toBe(true);
}, 30_000);

test("cancelling a queued sweep does not reject the next mirror operation", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "failed", old);
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const refresh = ensureBareMirror({
    ...repository,
    remoteUrl: fixture.source,
    pawsRoot: fixture.pawsRoot,
    networkGit: async (args) => {
      entered();
      await gate;
      return git(args);
    },
  });
  await reached;
  let held!: () => void;
  const holding = new Promise<void>((done) => {
    held = done;
  });
  const controller = new AbortController();
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    const sweep = sweepWorktrees(
      fixture.sweep({
        signal: controller.signal,
        hold: async (_ids, operation) => {
          held();
          await operation();
        },
      }),
    );
    const rejection = sweep.then(
      () => null,
      (error: unknown) => error,
    );
    await holding;
    const following = createWorktree({
      ...repository,
      itemId: "ENG-2",
      pawsRoot: fixture.pawsRoot,
    });
    controller.abort(new Error("stop sweep"));
    release();
    const [error] = await Promise.all([rejection, refresh, following]);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("stop sweep");
    expect(fixture.present()["ENG-1"]).toBe(true);
    expect(lines.some((line) => line.includes("operation=worktree.onMirror"))).toBe(false);
  } finally {
    release();
    restore();
  }
}, 30_000);

test("creation queued during removal uses the same mirror lock", async () => {
  const fixture = await setup();
  const key = "ENG-1";
  await fixture.item(key, "failed", old);
  const path = worktreePath(fixture.pawsRoot, key);
  await writeFile(join(path, "old.txt"), "old checkout");
  let creation: ReturnType<typeof createWorktree> | undefined;
  let checked = false;
  await removeWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot }, () => {
    checked = true;
    creation = createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
    return true;
  });
  await creation;
  expect(checked).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(existsSync(join(path, "old.txt"))).toBe(false);
}, 30_000);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "paws-sweep-"));
  roots.push(root);
  const source = join(root, "source");
  const pawsRoot = join(root, "paws");
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(["-C", source, "add", "README.md"]);
  await commitIn(source, "init");
  await ensureBareMirror({ ...repository, remoteUrl: source, pawsRoot });
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const ids: string[] = [];
  return {
    db,
    source,
    pawsRoot,
    async item(id: string, state: WorkItemRecord["state"], touched: number) {
      ids.push(id);
      const item = insertQueuedItem(db, { id });
      db.run("UPDATE work_item SET state = ? WHERE id = ?", [state, id]);
      insertRun(db, { itemId: id, now: touched, status: "ended" });
      const tree = await createWorktree({ ...repository, itemId: id, pawsRoot });
      await utimes(tree.path, touched / 1000, touched / 1000);
      return { ...item, state };
    },
    present() {
      return Object.fromEntries(ids.map((id) => [id, existsSync(worktreePath(pawsRoot, id))]));
    },
    sweep(overrides: Partial<WorktreeSweep> = {}): WorktreeSweep {
      return {
        db,
        pawsRoot,
        now,
        signal: new AbortController().signal,
        repositoryForItem: () => repository,
        busy: () => false,
        hold: (_itemIds, operation) => operation(),
        ...overrides,
      };
    },
  };
}

async function commitIn(dir: string, message: string): Promise<void> {
  await git([
    "-C",
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}
