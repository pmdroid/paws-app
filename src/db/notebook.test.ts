import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lockNotebookSteps,
  notebookChangesSteps,
  notebookStateSteps,
  writeNotebookSteps,
  type Db,
  type NotebookScope,
  type NotebookWrite,
} from "./index";
import { tempStore } from "../../test/pglite";

let db: Db;
let close: () => Promise<void>;

const scope: NotebookScope = { workspaceId: "w", kind: "repository", id: "o/r" };
const other: NotebookScope = { workspaceId: "w", kind: "project", id: "o/r" };

beforeEach(async () => {
  ({ db, close } = await tempStore());
});

afterEach(() => close());

const write = (writes: NotebookWrite[], now: number, itemId: string | null = "item") =>
  db.transaction(function* (q) {
    yield* lockNotebookSteps(q, scope, now);
    return yield* writeNotebookSteps(q, scope, { writes, itemId, actorId: itemId && "user", now });
  });

test("writes apply entries, record one change each and add one to the revision", async () => {
  const added = await write(
    [
      { action: "add", body: "one" },
      { action: "add", body: "two" },
    ],
    10,
  );
  const [one, two] = added.map((change) => change.entryId);
  await write(
    [
      { action: "patch", entryId: one!, before: "one", body: "uno" },
      { action: "remove", entryId: two!, before: "two" },
    ],
    20,
    null,
  );
  const state = await db.run((q) => notebookStateSteps(q, scope));
  expect(state).toMatchObject({
    revision: 2,
    entries: [{ id: one!, body: "uno", createdAt: 10, updatedAt: 20 }],
  });
  const changes = await db.run((q) => notebookChangesSteps(q, scope, { limit: 10 }));
  expect(changes.map((c) => [c.action, c.before, c.after, c.itemId, c.actorId, c.at])).toEqual([
    ["remove", "two", null, null, null, 20],
    ["patch", "one", "uno", null, null, 20],
    ["add", null, "two", "item", "user", 10],
    ["add", null, "one", "item", "user", 10],
  ]);
  expect(await db.run((q) => notebookChangesSteps(q, scope, { id: changes[1]!.id }))).toEqual([
    changes[1]!,
  ]);
  expect(await db.run((q) => notebookChangesSteps(q, other, { id: changes[1]!.id }))).toEqual([]);
  expect(await db.run((q) => notebookStateSteps(q, other))).toEqual({ revision: 0, entries: [] });
});

test("the scope kind is checked", async () => {
  const bad = { ...scope, kind: "team" } as unknown as NotebookScope;
  await expect(db.transaction((q) => lockNotebookSteps(q, bad, 1))).rejects.toThrow();
});
