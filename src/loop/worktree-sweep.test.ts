import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createWorktree, ensureBareMirror, git, worktreePath } from "../acp";
import { insertQueuedItem, insertRun, migrate, openDatabase, type WorkItemRecord } from "../db";
import { setJournalSink } from "../journal";
import {
  recordWorktreeOwner,
  RETIRED_WORKTREE_MS,
  sweepWorktrees,
  type WorktreeSweep,
} from "./worktree-sweep";

const roots: string[] = [];
const repository = { owner: "acme", repo: "demo", remoteUrl: "" };
const now = Date.UTC(2026, 9, 17);
const old = now - RETIRED_WORKTREE_MS - 60_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("removes orphaned worktrees and preserves live worktrees", async () => {
  const fixture = await setup();
  insertQueuedItem(fixture.db, { id: "ENG-orphan" });
  await createWorktree({ ...repository, itemId: "ENG-orphan", pawsRoot: fixture.pawsRoot });
  recordWorktreeOwner(fixture.pawsRoot, "ENG-orphan", "ENG-orphan");
  fixture.db.run("DELETE FROM work_item WHERE id = 'ENG-orphan'");
  await fixture.item("ENG-live", "running", old);
  await sweepWorktrees(fixture.sweep());
  expect(existsSync(worktreePath(fixture.pawsRoot, "ENG-orphan"))).toBe(false);
  expect(existsSync(worktreePath(fixture.pawsRoot, "ENG-live"))).toBe(true);
}, 30_000);

test("keeps probe and custom worktrees without recorded item ownership", async () => {
  const fixture = await setup();
  for (const key of ["probes-123456", "custom-probes", "ENG-99"]) {
    await createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
  }

  await sweepWorktrees(fixture.sweep());

  for (const key of ["probes-123456", "custom-probes", "ENG-99"])
    expect(existsSync(worktreePath(fixture.pawsRoot, key))).toBe(true);
}, 30_000);

test("keeps clean and dirty worktrees belonging to renamed live items", async () => {
  const fixture = await setup();
  for (const [id, state] of [
    ["ENG-10", "paused"],
    ["ENG-11", "awaiting_input"],
  ] as const) {
    await fixture.item(id, state, old);
  }
  await sweepWorktrees(fixture.sweep());
  const dirty = join(worktreePath(fixture.pawsRoot, "ENG-11"), "unfinished.txt");
  await writeFile(dirty, "unfinished work");
  fixture.db.run("UPDATE work_item SET linear_identifier = 'MOVED-' || linear_identifier");

  await sweepWorktrees(fixture.sweep());

  expect(fixture.present()).toEqual({ "ENG-10": true, "ENG-11": true });
  expect(await Bun.file(dirty).text()).toBe("unfinished work");
}, 30_000);

test("retains dirty orphan worktrees until their changes are saved", async () => {
  const fixture = await setup();
  const id = "ENG-12";
  await createWorktree({ ...repository, itemId: id, pawsRoot: fixture.pawsRoot });
  recordWorktreeOwner(fixture.pawsRoot, id, id);
  const dirty = join(worktreePath(fixture.pawsRoot, id), "unfinished.txt");
  await writeFile(dirty, "unfinished work");

  await sweepWorktrees(fixture.sweep());
  expect(await Bun.file(dirty).text()).toBe("unfinished work");

  await rm(dirty);
  await sweepWorktrees(fixture.sweep());
  expect(existsSync(worktreePath(fixture.pawsRoot, id))).toBe(false);
}, 30_000);

test("does not inherit ownership when a probe reuses a removed item path", async () => {
  const fixture = await setup();
  const key = "ENG-13";
  await createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
  recordWorktreeOwner(fixture.pawsRoot, key, key);
  await sweepWorktrees(fixture.sweep());
  expect(existsSync(worktreePath(fixture.pawsRoot, key))).toBe(false);

  await createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
  await sweepWorktrees(fixture.sweep());
  expect(existsSync(worktreePath(fixture.pawsRoot, key))).toBe(true);
}, 30_000);

test("holds former item IDs and rechecks owners before removing an orphan", async () => {
  const fixture = await setup();
  const key = "ENG-14";
  await createWorktree({ ...repository, itemId: key, pawsRoot: fixture.pawsRoot });
  recordWorktreeOwner(fixture.pawsRoot, key, key);
  const held: string[][] = [];
  await sweepWorktrees(
    fixture.sweep({
      hold: async (ids, operation) => {
        held.push([...ids]);
        const restored = insertQueuedItem(fixture.db, { id: key });
        fixture.db.run("UPDATE work_item SET linear_identifier = 'MOVED-14' WHERE id = ?", [
          restored.id,
        ]);
        await operation();
      },
    }),
  );
  expect(held).toEqual([[key]]);
  expect(existsSync(worktreePath(fixture.pawsRoot, key))).toBe(true);
}, 30_000);

test("retires a failed worktree after seven days despite an unresolvable merged head", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "failed", old);
  fixture.db.run(
    "INSERT INTO work_item_event (item_id, version, at, from_state, to_state, event) VALUES (?, 1, ?, 'running', 'failed', 'fail')",
    ["ENG-1", now - 60_000],
  );
  let lookups = 0;
  const sweep = fixture.sweep({
    mergedHeads: async () => {
      lookups++;
      return ["missing-commit"];
    },
  });
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await sweepWorktrees(sweep);
    expect(fixture.present()["ENG-1"]).toBe(true);
    expect(lookups).toBe(1);
    expect(lines.join("\n")).toContain("operation=worktree.worktreeMergedInto.git");
    expect(lines.join("\n")).toContain("missing-commit");
    await sweepWorktrees({ ...sweep, now: now + RETIRED_WORKTREE_MS });
    expect(fixture.present()["ENG-1"]).toBe(false);
    expect(lookups).toBe(1);
  } finally {
    restore();
  }
}, 30_000);

test("keeps a cancelled worktree for seven days even when its head was merged", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "cancelled", old);
  fixture.db.run(
    "INSERT INTO work_item_event (item_id, version, at, from_state, to_state, event) VALUES (?, 1, ?, 'running', 'cancelled', 'cancel')",
    ["ENG-1", now - 60_000],
  );
  const head = (
    await git(["-C", worktreePath(fixture.pawsRoot, "ENG-1"), "rev-parse", "HEAD"])
  ).trim();
  const sweep = fixture.sweep({ mergedHeads: async () => [head] });
  await sweepWorktrees(sweep);
  expect(fixture.present()["ENG-1"]).toBe(true);
  await sweepWorktrees({ ...sweep, now: now + RETIRED_WORKTREE_MS });
  expect(fixture.present()["ENG-1"]).toBe(false);
}, 30_000);

test("removes finished worktrees after seven idle days and keeps recent or waiting ones", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "cancelled", old);
  await fixture.item("ENG-2", "failed", old);
  await fixture.item("ENG-3", "failed", now - 60_000);
  await fixture.item("ENG-4", "awaiting_input", old);
  await fixture.item("ENG-5", "merged", now - 60_000);
  await fixture.item("ENG-6", "merged", old);
  insertRun(fixture.db, { itemId: "ENG-2", now: now - 60_000, status: "lost" });

  await sweepWorktrees(fixture.sweep());

  expect(fixture.present()).toEqual({
    "ENG-1": false,
    "ENG-2": true,
    "ENG-3": true,
    "ENG-4": true,
    "ENG-5": true,
    "ENG-6": false,
  });
}, 30_000);

test("removes a waiting worktree only when its clean HEAD was merged on GitHub", async () => {
  const fixture = await setup();
  const merged = await fixture.item("ENG-1", "awaiting_input", now - 60_000);
  const ahead = await fixture.item("ENG-2", "awaiting_input", now - 60_000);
  const dirty = await fixture.item("ENG-3", "paused", now - 60_000);
  const busy = await fixture.item("ENG-4", "manual", now - 60_000);
  await fixture.item("ENG-5", "running", now - 60_000);
  const heads = new Map<string, string>();
  for (const id of ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"])
    heads.set(id, await fixture.commit(id, "feature.txt"));
  await fixture.commit("ENG-2", "later.txt");
  await writeFile(join(worktreePath(fixture.pawsRoot, "ENG-3"), "feature.txt"), "edited\n");
  const asked: string[] = [];

  await sweepWorktrees(
    fixture.sweep({
      busy: (itemId) => itemId === busy.id,
      mergedHeads: async (item) => {
        asked.push(item.id);
        return [heads.get(item.id)!];
      },
    }),
  );

  expect(fixture.present()).toEqual({
    "ENG-1": false,
    "ENG-2": true,
    "ENG-3": true,
    "ENG-4": true,
    "ENG-5": true,
  });
  expect(asked.sort()).toEqual([merged.id, ahead.id, dirty.id].sort());
}, 30_000);

test("keeps a worktree another live item shares", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "cancelled", old);
  const sibling = insertQueuedItem(fixture.db, { id: "ENG-1-again" });
  fixture.db.run(
    "UPDATE work_item SET linear_identifier = 'ENG-1', state = 'running' WHERE id = ?",
    [sibling.id],
  );

  await sweepWorktrees(fixture.sweep());

  expect(existsSync(worktreePath(fixture.pawsRoot, "ENG-1"))).toBe(true);
}, 30_000);

test("keeps a worktree when its owners or files change before removal", async () => {
  const fixture = await setup();
  await fixture.item("ENG-1", "awaiting_input", now - 60_000);
  await fixture.item("ENG-2", "cancelled", old);
  await fixture.item("ENG-3", "awaiting_input", now - 60_000);
  const heads = new Map([
    ["ENG-1", await fixture.commit("ENG-1", "feature.txt")],
    ["ENG-3", await fixture.commit("ENG-3", "feature.txt")],
  ]);
  const held: string[][] = [];

  await sweepWorktrees(
    fixture.sweep({
      mergedHeads: async (item) => {
        if (item.id === "ENG-1")
          fixture.db.run("UPDATE work_item SET state = 'running' WHERE id = 'ENG-1'");
        return [heads.get(item.id)!];
      },
      hold: async (itemIds, operation) => {
        held.push([...itemIds]);
        if (itemIds.includes("ENG-2")) {
          const sibling = insertQueuedItem(fixture.db, { id: "ENG-2-again" });
          fixture.db.run("UPDATE work_item SET linear_identifier = 'ENG-2' WHERE id = ?", [
            sibling.id,
          ]);
        }
        if (itemIds.includes("ENG-3"))
          await writeFile(join(worktreePath(fixture.pawsRoot, "ENG-3"), "late.txt"), "late\n");
        await operation();
      },
    }),
  );

  expect(held).toEqual([["ENG-1"], ["ENG-2"], ["ENG-3"]]);
  expect(fixture.present()).toEqual({ "ENG-1": true, "ENG-2": true, "ENG-3": true });
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
    async commit(id: string, file: string) {
      const tree = worktreePath(pawsRoot, id);
      await writeFile(join(tree, file), `${id} ${file}\n`);
      await git(["-C", tree, "add", file]);
      await commitIn(tree, file);
      return (await git(["-C", tree, "rev-parse", "HEAD"])).trim();
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
        mergedHeads: async () => [],
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
