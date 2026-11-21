import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { putWorkspaceUserSteps, syncWorkspaceMemberSteps, type Db } from "../db";
import type { WorkspacePrincipal } from "../workspace";
import { insertWorkItemSteps, withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import { createNotebookHttp, notebookChanges } from "./index";

let db: Db;
let close: () => Promise<void>;
let clock = 1_000;

beforeEach(async () => {
  ({ db, close } = await tempStore());
  await withoutForeignKeys(db);
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "ws", createdAt: 0 }),
    );
    for (const [id, role, team] of [
      ["ann", "member", "eng"],
      ["bob", "member", "ops"],
      ["root", "admin", "ops"],
    ] as const) {
      yield* putWorkspaceUserSteps(q, { id, linearUserId: id, name: id.toUpperCase(), email: "" });
      yield* syncWorkspaceMemberSteps(q, {
        ...{ workspaceId: "ws", userId: id, role, active: true },
        ...{ teamIds: [team], now: 1 },
      });
    }
    yield* q.exec(
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: "acme/app", teamId: "eng" }),
    );
    yield* insertWorkItemSteps(q, "PAS-1");
    yield* q.exec(
      q.orm
        .update(q.t.workItem)
        .set({ ownerUserId: "ann", linearProjectId: "p1", linearProjectName: "Launch" })
        .where(eq(q.t.workItem.id, "PAS-1")),
    );
  });
});

afterEach(() => close());

type Reply = {
  entries: { body: string }[];
  changes: { id: string }[];
  notebooks: ({ name: string } & Record<string, unknown>)[];
};

async function call(userId: string, path: string, body?: unknown, role?: "admin") {
  const request = new Request(`http://paws.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });
  const principal = { workspaceId: "ws", userId, role: role ?? "member", authenticatedAt: 0 };
  const http = createNotebookHttp({ db, now: () => ++clock });
  const response = await http(request, { ...principal, teamIds: [] } as WorkspacePrincipal);
  return { status: response!.status, body: (await response!.json()) as Reply };
}

const REPO = "/api/notebooks/repository/acme%2Fapp";
const PROJECT = "/api/notebooks/project/p1";

test("a member with the repository sees its notebook and others get 404", async () => {
  expect(
    (await call("ann", `${REPO}/edits`, { operations: [{ action: "add", content: "use bun" }] }))
      .status,
  ).toBe(200);
  const read = await call("ann", REPO);
  expect(read).toMatchObject({ status: 200, body: { size: 7, limit: 12_000 } });
  expect(read.body.entries.map((entry) => entry.body)).toEqual(["use bun"]);
  const listed = await call("ann", "/api/notebooks");
  expect(listed.body.notebooks).toContainEqual({
    kind: "repository",
    id: "acme/app",
    name: "acme/app",
    size: 7,
    limit: 12_000,
  });
  expect((await call("bob", REPO)).status).toBe(404);
  expect((await call("bob", `${REPO}/edits`, { operations: [] })).status).toBe(404);
  expect((await call("bob", "/api/notebooks")).body.notebooks).toEqual([]);
  expect((await call("root", REPO, undefined, "admin")).status).toBe(200);
  expect((await call("nobody", REPO)).status).toBe(404);
});

test("a member who owns an item in the project sees the project notebook", async () => {
  await call("ann", `${PROJECT}/edits`, { operations: [{ action: "add", content: "ship it" }] });
  expect((await call("ann", PROJECT)).body).toMatchObject({ size: 7, limit: 4_000 });
  expect((await call("ann", "/api/notebooks")).body.notebooks).toContainEqual({
    kind: "project",
    id: "p1",
    name: "Launch",
    size: 7,
    limit: 4_000,
  });
  expect((await call("bob", PROJECT)).status).toBe(404);
  expect((await call("bob", "/api/notebooks")).body.notebooks).toEqual([]);
  expect(
    (await call("root", "/api/notebooks", undefined, "admin")).body.notebooks.map(
      (notebook) => notebook.name,
    ),
  ).toEqual(["Launch"]);
});

test("a member's edit records them as the actor, and undo restores a patch", async () => {
  await call("ann", `${REPO}/edits`, { operations: [{ action: "add", content: "alpha" }] });
  const patched = await call("ann", `${REPO}/edits`, {
    operations: [{ action: "patch", old_text: "alpha", content: "beta" }],
  });
  expect(patched.status).toBe(200);
  const changes = await notebookChanges(db, {
    workspaceId: "ws",
    kind: "repository",
    id: "acme/app",
  });
  expect(changes.map((change) => [change.action, change.actorId, change.itemId])).toEqual([
    ["patch", "ann", null],
    ["add", "ann", null],
  ]);
  expect(patched.body.changes[0]).toMatchObject({
    action: "patch",
    before: "alpha",
    after: "beta",
    actor: "ANN",
    item: null,
    undoable: true,
  });
  expect(patched.body.changes[1]).toMatchObject({ action: "add", undoable: false });
  const undone = await call("ann", `${REPO}/undo`, { changeId: patched.body.changes[0]!.id });
  expect(undone.status).toBe(200);
  expect(undone.body.entries.map((entry) => entry.body)).toEqual(["alpha"]);
  const refused = await call("ann", `${REPO}/undo`, { changeId: patched.body.changes[0]!.id });
  expect(refused).toMatchObject({
    status: 409,
    body: { error: "the entry has changed since" },
  });
  expect(
    (await call("ann", `${REPO}/edits`, { operations: [{ action: "remove", old_text: "zzz" }] }))
      .status,
  ).toBe(409);
  expect((await call("ann", `${REPO}/undo`, {})).status).toBe(400);
});
