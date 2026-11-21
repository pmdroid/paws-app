import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Db } from "../db";
import { tempStore } from "../../test/pglite";
import {
  NOTEBOOK_LIMITS,
  editNotebook,
  notebookChanges,
  readNotebook,
  renderNotebook,
  undoNotebookChange,
  type NotebookOperation,
  type NotebookScope,
} from "./index";

let db: Db;
let close: () => Promise<void>;

const repo: NotebookScope = { workspaceId: "w", kind: "repository", id: "o/r" };
const project: NotebookScope = { workspaceId: "w", kind: "project", id: "p" };
let clock = 100;
const actor = () => ({ itemId: "item", actorId: "user", now: ++clock });

beforeEach(async () => {
  ({ db, close } = await tempStore());
  clock = 100;
});

afterEach(() => close());

const edit = (operations: NotebookOperation[], scope = repo) =>
  editNotebook(db, scope, operations, actor());

const bodies = async (scope = repo) => (await readNotebook(db, scope)).entries.map((e) => e.body);

test("add, patch and remove apply and each records a change", async () => {
  const added = await edit([
    { action: "add", content: "  run bun install first  " },
    { action: "add", content: "tests need PGlite" },
  ]);
  expect(added).toMatchObject({ ok: true, revision: 1, size: 38, limit: 12_000 });
  if (added.ok) expect(added.applied.map((a) => a.entryId)).toEqual(added.entries.map((e) => e.id));
  const edited = await edit([
    { action: "patch", old_text: "PGlite", content: "tests use PGlite, never Docker" },
    { action: "remove", old_text: "bun install" },
  ]);
  expect(edited).toMatchObject({ ok: true, revision: 2 });
  const changes = await notebookChanges(db, repo);
  expect(changes.map((c) => [c.action, c.itemId, c.actorId, c.at])).toEqual([
    ["remove", "item", "user", 102],
    ["patch", "item", "user", 102],
    ["add", "item", "user", 101],
    ["add", "item", "user", 101],
  ]);
  const { entries } = await readNotebook(db, repo);
  expect(renderNotebook(entries)).toBe("- tests use PGlite, never Docker");
});

test("a call with one failing operation writes nothing", async () => {
  await edit([{ action: "add", content: "alpha" }]);
  const result = await edit([
    { action: "add", content: "beta" },
    { action: "patch", old_text: "alpha", content: "  " },
  ]);
  expect(result).toMatchObject({ ok: false, operation: 1, revision: 1 });
  expect(await bodies()).toEqual(["alpha"]);
  expect(await notebookChanges(db, repo)).toHaveLength(1);
  expect(await edit([])).toMatchObject({ ok: false });
  expect(await edit([{ action: "add", content: "x".repeat(1_001) }])).toMatchObject({ ok: false });
});

test("old_text matching two entries or none fails with the current entries", async () => {
  await edit([
    { action: "add", content: "deploy on friday" },
    { action: "add", content: "never deploy on monday" },
  ]);
  const twice = await edit([{ action: "remove", old_text: "deploy on" }]);
  expect(twice).toMatchObject({ ok: false, reason: "operation 1: old_text matches 2 entries" });
  expect(twice.entries.map((e) => e.body)).toEqual(["deploy on friday", "never deploy on monday"]);
  const none = await edit([{ action: "patch", old_text: "tuesday", content: "x" }]);
  expect(none).toMatchObject({ ok: false, reason: "operation 1: old_text matches no entry" });
  expect(none.entries).toHaveLength(2);
});

test("the same text added twice is stored once", async () => {
  await edit([{ action: "add", content: "use  the\nfake  GitHub" }]);
  const again = await edit([{ action: "add", content: "use the fake GitHub " }]);
  expect(again).toMatchObject({
    ok: true,
    revision: 1,
    changes: [],
    applied: [{ duplicate: true }],
  });
  expect(await bodies()).toHaveLength(1);
});

test("the limit is checked on the whole call", async () => {
  const big = (letter: string) => letter.repeat(1_000);
  await edit(
    [..."abcd"].map((letter) => ({ action: "add" as const, content: big(letter) })),
    project,
  );
  const over = await edit([{ action: "add", content: big("e") }], project);
  expect(over).toMatchObject({ ok: false, size: 4_000, limit: NOTEBOOK_LIMITS.project });
  if (!over.ok) expect(over.reason).toContain("over its 4000 limit");
  expect(over.entries).toHaveLength(4);
  expect(await notebookChanges(db, project)).toHaveLength(4);
  const fits = await edit(
    [
      { action: "add", content: big("e") },
      { action: "remove", old_text: "aaaa" },
    ],
    project,
  );
  expect(fits).toMatchObject({ ok: true, size: 4_000 });
});

test("concurrent adds both land, unless together they exceed the limit", async () => {
  const both = await Promise.all([
    edit([{ action: "add", content: "left" }]),
    edit([{ action: "add", content: "right" }]),
  ]);
  expect(both.map((r) => r.ok)).toEqual([true, true]);
  expect((await bodies()).toSorted()).toEqual(["left", "right"]);
  expect((await readNotebook(db, repo)).revision).toBe(2);

  await edit(
    [..."abc"].map((l) => ({ action: "add" as const, content: l.repeat(1_000) })),
    project,
  );
  const racing = await Promise.all([
    edit([{ action: "add", content: "x".repeat(800) }], project),
    edit([{ action: "add", content: "y".repeat(800) }], project),
  ]);
  expect(racing.filter((r) => r.ok)).toHaveLength(1);
  expect(await bodies(project)).toHaveLength(4);
});

test("undo restores a patched entry and refuses when the entry changed again", async () => {
  await edit([{ action: "add", content: "first wording" }]);
  await edit([{ action: "patch", old_text: "first", content: "second wording" }]);
  const [patch] = await notebookChanges(db, repo);
  const undone = await undoNotebookChange(db, repo, patch!.id, actor());
  expect(undone).toMatchObject({ ok: true, revision: 3 });
  expect(await bodies()).toEqual(["first wording"]);

  await edit([{ action: "patch", old_text: "first", content: "third wording" }]);
  await edit([{ action: "patch", old_text: "third", content: "fourth wording" }]);
  const [, third] = await notebookChanges(db, repo);
  const refused = await undoNotebookChange(db, repo, third!.id, actor());
  expect(refused).toMatchObject({ ok: false, reason: "the entry has changed since" });
  expect(await bodies()).toEqual(["fourth wording"]);
});

test("undo deletes an add and brings a removed entry back unless it is there again", async () => {
  await edit([{ action: "add", content: "keep me" }]);
  const [add] = await notebookChanges(db, repo);
  await undoNotebookChange(db, repo, add!.id, actor());
  expect(await bodies()).toEqual([]);
  const [remove] = await notebookChanges(db, repo);
  expect(remove!.action).toBe("remove");
  await edit([{ action: "add", content: "keep me" }]);
  expect(await undoNotebookChange(db, repo, remove!.id, actor())).toMatchObject({
    ok: false,
    reason: "the same text is in the notebook again",
  });
  await edit([{ action: "remove", old_text: "keep" }]);
  expect(await undoNotebookChange(db, repo, remove!.id, actor())).toMatchObject({ ok: true });
  expect(await bodies()).toEqual(["keep me"]);
  expect(await undoNotebookChange(db, repo, "missing", actor())).toMatchObject({ ok: false });
});

test("stored text has secrets removed", async () => {
  const token = `ghp_${"a".repeat(30)}`;
  await edit([{ action: "add", content: `push with ${token}` }]);
  const [body] = await bodies();
  expect(body).toBe("push with [redacted]");
  expect(JSON.stringify(await notebookChanges(db, repo))).not.toContain(token);
});
