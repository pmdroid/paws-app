import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  putWorkspaceUserSteps,
  replaceLinearProjectTeamsSteps,
  syncWorkspaceMemberSteps,
  type Db,
} from "../db";
import { insertWorkItemSteps, withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import { createNotebookHttp, notebookChanges, type NotebookChannelAccess } from "./index";

let db: Db;
let close: () => Promise<void>;
let clock = 1_000;

beforeEach(async () => {
  channel = null;
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
      ["cid", "member", "eng"],
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

const SLACK: Record<string, string> = { ann: "U-ANN", bob: "U-BOB", root: "U-ROOT" };
let channel: { slackUserIds: ReadonlySet<string>; name: string | null } | null = null;
const channelAccess: NotebookChannelAccess = {
  members: async (workspaceId, id) => (workspaceId === "ws" && id === "T1:C1" ? channel : null),
  slackUserId: async (_workspaceId, userId) => SLACK[userId] ?? null,
};

async function call(userId: string, path: string, body?: unknown) {
  const request = new Request(`http://paws.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });
  const http = createNotebookHttp({ db, now: () => ++clock, channelAccess });
  const response = await http(request, { workspaceId: "ws", userId });
  return { status: response!.status, body: (await response!.json()) as Reply };
}

const REPO = "/api/notebooks/repository/acme%2Fapp";
const PROJECT = "/api/notebooks/project/p1";
const CHANNEL = "/api/notebooks/channel/T1%3AC1";
const ADD = (content: string) => ({ operations: [{ action: "add", content }] });
const names = async (userId: string) =>
  (await call(userId, "/api/notebooks")).body.notebooks.map((notebook) => notebook.name);
const projectTeams = (teamIds: string[]) =>
  db.run((q) =>
    replaceLinearProjectTeamsSteps(q, { workspaceId: "ws", projectId: "p1", teamIds, now: 1 }),
  );

test("a member with the repository sees its notebook and others, admins included, get 404", async () => {
  expect((await call("ann", `${REPO}/edits`, ADD("use bun"))).status).toBe(200);
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
  expect(await names("bob")).toEqual(["Your notebook"]);
  expect((await call("root", REPO)).status).toBe(404);
  expect((await call("root", `${REPO}/edits`, ADD("x"))).status).toBe(404);
  expect(await names("root")).toEqual(["Your notebook"]);
  expect((await call("nobody", REPO)).status).toBe(404);
  expect((await call("nobody", "/api/notebooks")).body.notebooks).toEqual([]);
});

test("a project notebook belongs to members who share a Linear team with the project", async () => {
  expect((await call("ann", PROJECT)).status).toBe(404);
  expect((await call("ann", `${PROJECT}/edits`, ADD("early"))).status).toBe(404);
  await projectTeams(["eng", "design"]);
  expect((await call("ann", `${PROJECT}/edits`, ADD("ship it"))).status).toBe(200);
  expect((await call("ann", PROJECT)).body).toMatchObject({ size: 7, limit: 4_000 });
  expect((await call("ann", "/api/notebooks")).body.notebooks).toContainEqual({
    kind: "project",
    id: "p1",
    name: "Launch",
    size: 7,
    limit: 4_000,
  });
  expect((await call("cid", PROJECT)).status).toBe(200);
  expect((await call("bob", PROJECT)).status).toBe(404);
  expect((await call("bob", `${PROJECT}/edits`, ADD("x"))).status).toBe(404);
  expect((await call("root", PROJECT)).status).toBe(404);
  expect(await names("root")).toEqual(["Your notebook"]);
  await projectTeams([]);
  expect((await call("ann", PROJECT)).status).toBe(404);
  expect(await names("ann")).toEqual(["Your notebook"]);
});

test("a channel notebook belongs to the members whose Slack user is in the channel", async () => {
  channel = { slackUserIds: new Set(["U-ANN"]), name: "ops" };
  expect((await call("ann", `${CHANNEL}/edits`, ADD("standup at 9"))).status).toBe(200);
  expect((await call("ann", CHANNEL)).body).toMatchObject({ size: 12, limit: 4_000 });
  expect((await call("ann", "/api/notebooks")).body.notebooks).toContainEqual({
    kind: "channel",
    id: "T1:C1",
    name: "#ops",
    size: 12,
    limit: 4_000,
  });
  expect((await call("bob", CHANNEL)).status).toBe(404);
  expect((await call("bob", `${CHANNEL}/edits`, ADD("x"))).status).toBe(404);
  expect(await names("bob")).toEqual(["Your notebook"]);
  expect((await call("cid", CHANNEL)).status).toBe(404);
  channel = { slackUserIds: new Set(["U-ANN"]), name: null };
  expect(await names("ann")).toEqual(["Your notebook", "#T1:C1"]);
  channel = null;
  expect((await call("ann", CHANNEL)).status).toBe(404);
  expect((await call("ann", `${CHANNEL}/edits`, ADD("x"))).status).toBe(404);
  expect(await names("ann")).toEqual(["Your notebook"]);
});

test("a personal notebook is its owner's alone and always listed first", async () => {
  expect((await call("ann", "/api/notebooks")).body.notebooks).toEqual([
    { kind: "user", id: "ann", name: "Your notebook", size: 0, limit: 4_000 },
  ]);
  expect((await call("ann", "/api/notebooks/user/ann")).body).toMatchObject({
    kind: "user",
    size: 0,
    limit: 4_000,
    entries: [],
  });
  await call("ann", `${REPO}/edits`, ADD("use bun"));
  expect((await call("ann", "/api/notebooks/user/ann/edits", ADD("mine"))).status).toBe(200);
  expect((await call("ann", "/api/notebooks")).body.notebooks).toEqual([
    { kind: "user", id: "ann", name: "Your notebook", size: 4, limit: 4_000 },
    { kind: "repository", id: "acme/app", name: "acme/app", size: 7, limit: 12_000 },
  ]);
  expect((await call("root", "/api/notebooks/user/ann")).status).toBe(404);
  expect((await call("root", "/api/notebooks/user/ann/edits", ADD("x"))).status).toBe(404);
  expect((await call("bob", "/api/notebooks/user/ann")).status).toBe(404);
  expect((await call("root", "/api/notebooks")).body.notebooks).toEqual([
    { kind: "user", id: "root", name: "Your notebook", size: 0, limit: 4_000 },
  ]);
  expect((await call("ann", "/api/notebooks/team/ann")).status).toBe(404);
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
