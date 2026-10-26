import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createWorktree, ensureBareMirror, git, worktreePath } from "../acp";
import { insertQueuedItem, insertRun, migrate, openDatabase, type WorkItemRecord } from "../db";
import { RETIRED_WORKTREE_MS, sweepWorktrees, type WorktreeSweep } from "./worktree-sweep";

const roots: string[] = [];
const repository = { owner: "acme", repo: "demo", remoteUrl: "" };
const now = Date.UTC(2026, 9, 17);
const old = now - RETIRED_WORKTREE_MS - 60_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
