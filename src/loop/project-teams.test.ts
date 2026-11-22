import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  linearProjectTeamsSteps,
  lockNotebookSteps,
  putWorkspaceUserSteps,
  replaceLinearProjectTeamsSteps,
  syncWorkspaceMemberSteps,
  writeNotebookSteps,
  type Db,
} from "../db";
import { createFakeTracker } from "../linear";
import { createNotebookHttp } from "../notebook";
import { withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import { recordMissingProjectTeams } from "./index";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await tempStore());
  await withoutForeignKeys(db);
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "ws", createdAt: 0 }),
    );
    yield* putWorkspaceUserSteps(q, { id: "ann", linearUserId: "ann", name: "Ann", email: "" });
    yield* syncWorkspaceMemberSteps(q, {
      ...{ workspaceId: "ws", userId: "ann", role: "member", active: true },
      ...{ teamIds: ["eng"], now: 1 },
    });
    for (const id of ["p1", "p2"]) {
      const scope = { workspaceId: "ws", kind: "project", id } as const;
      yield* lockNotebookSteps(q, scope, 1);
      yield* writeNotebookSteps(q, scope, {
        writes: [{ action: "add", body: `notes for ${id}` }],
        ...{ itemId: null, actorId: null, now: 1 },
      });
    }
    yield* replaceLinearProjectTeamsSteps(q, {
      ...{ workspaceId: "ws", projectId: "p2", teamIds: ["ops"], now: 1 },
    });
  });
});

afterEach(() => close());

async function read(path: string) {
  const http = createNotebookHttp({
    db,
    now: () => 10,
    channelAccess: { members: async () => null, slackUserId: async () => null },
  });
  const response = await http(new Request(`http://paws.test${path}`), {
    workspaceId: "ws",
    userId: "ann",
  });
  return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
}

const projectIds = async () =>
  ((await read("/api/notebooks")).body["notebooks"] as { kind: string; id: string }[])
    .filter((notebook) => notebook.kind === "project")
    .map((notebook) => notebook.id);

test("startup stores the teams of a project notebook that has none, once per project", async () => {
  const tracker = createFakeTracker();
  tracker.projectTeamsById.set("p1", { id: "p1", teamIds: ["eng", "design"] });
  expect((await read("/api/notebooks/project/p1")).status).toBe(404);
  await recordMissingProjectTeams({ store: db, tracker, workspaceId: "ws", now: () => 5 });
  expect(tracker.projectTeamsReads).toEqual(["p1"]);
  expect(await db.run((q) => linearProjectTeamsSteps(q, "ws", "p1"))).toEqual(["design", "eng"]);
  expect(await db.run((q) => linearProjectTeamsSteps(q, "ws", "p2"))).toEqual(["ops"]);
  expect(await projectIds()).toEqual(["p1"]);
  const notebook = await read("/api/notebooks/project/p1");
  expect(notebook.status).toBe(200);
  expect((notebook.body["entries"] as { body: string }[]).map((entry) => entry.body)).toEqual([
    "notes for p1",
  ]);
  await recordMissingProjectTeams({ store: db, tracker, workspaceId: "ws", now: () => 6 });
  expect(tracker.projectTeamsReads).toEqual(["p1"]);
});

test("a failed or empty read stores nothing and the notebook stays hidden", async () => {
  const tracker = createFakeTracker();
  tracker.projectTeamsFailures.push(new Error("Linear is down"));
  await recordMissingProjectTeams({ store: db, tracker, workspaceId: "ws", now: () => 5 });
  await recordMissingProjectTeams({ store: db, tracker, workspaceId: "ws", now: () => 6 });
  expect(tracker.projectTeamsReads).toEqual(["p1", "p1"]);
  expect(await db.run((q) => linearProjectTeamsSteps(q, "ws", "p1"))).toEqual([]);
  expect((await read("/api/notebooks/project/p1")).status).toBe(404);
  expect(await projectIds()).toEqual([]);
});
