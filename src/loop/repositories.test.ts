import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  ensureLinearSessionSteps,
  getWorkItemSteps,
  insertRunSteps,
  putWorkspaceUserSteps,
  syncWorkspaceMemberSteps,
  writeRepositoryDescriptionSteps,
  type Db,
} from "../db";
import { createFakeSnapshotReader } from "../github";
import { repositoryGrant, repositoryNote, repositoryTools } from "./repositories";
import { insertWorkItemSteps, withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";

const stores: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(stores.map((store) => store.close())));

const SHA = "a".repeat(40);

async function setup(options: { mode?: string; repositories?: string[] } = {}) {
  const handle = await tempStore();
  stores.push(handle);
  const db: Db = handle.db;
  await withoutForeignKeys(db);
  const repositories = options.repositories ?? ["acme/app", "acme/docs", "acme/web", "ops/infra"];
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "ws", createdAt: 0 }),
    );
    yield* insertWorkItemSteps(q, "item");
    yield* q.exec(
      q.orm.update(q.t.workItem).set({ sessionKey: "session" }).where(eq(q.t.workItem.id, "item")),
    );
    yield* q.exec(
      q.orm.insert(q.t.workItemTask).values({ itemId: "item", mode: options.mode ?? "code" }),
    );
    yield* q.exec(
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: "item", owner: "acme", repo: "app", remoteUrl: "" }),
    );
    yield* ensureLinearSessionSteps(q, {
      ...{ sessionId: "session", organizationId: "org", appUserId: "app" },
      ...{ issueId: "issue-item", now: 0 },
    });
    yield* q.exec(
      q.orm
        .update(q.t.linearSession)
        .set({ creatorId: "linear-ann" })
        .where(eq(q.t.linearSession.sessionId, "session")),
    );
    yield* putWorkspaceUserSteps(q, {
      id: "ann",
      linearUserId: "linear-ann",
      name: "A",
      email: "a@x",
    });
    yield* syncWorkspaceMemberSteps(q, {
      ...{ workspaceId: "ws", userId: "ann", role: "member", active: true },
      ...{ teamIds: ["eng"], now: 1 },
    });
    for (const repository of repositories)
      yield* q.exec(
        q.orm
          .insert(q.t.workspaceRepository)
          .values({ workspaceId: "ws", repository, teamId: "eng" }),
      );
    yield* q.exec(
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: "other/secret", teamId: "ops" }),
    );
    yield* writeRepositoryDescriptionSteps(q, {
      ...{ workspaceId: "ws", repository: "acme/web", text: "The website." },
      ...{ source: "admin", contentHash: null, now: 1 },
    });
  });
  const run = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 0 }));
  const item = (await db.run((q) => getWorkItemSteps(q, "item")))!;
  const reader = createFakeSnapshotReader(
    Object.fromEntries(
      [...repositories, "other/secret"].map((name) => [
        name,
        { visibility: "private" as const, refs: { main: SHA }, defaultRef: "main", files: {} },
      ]),
    ),
  );
  const lines: string[] = [];
  const granted = repositoryGrant({ store: db, reader, journal: (line) => lines.push(line) });
  return { db, item, runId: run.id, reader, lines, granted };
}

test("a code-mode item's brief lists the delegator's other repositories with descriptions", async () => {
  const { db, item } = await setup();
  const note = (await repositoryNote(db, item))!;
  expect(note.split("\n").slice(1, 4)).toEqual([
    "acme/docs",
    "acme/web: The website.",
    "ops/infra",
  ]);
  expect(note).not.toContain("acme/app");
  expect(note).not.toContain("other/secret");
  expect(note).toContain("add_repository, at most 5 per run");
  expect(note).toContain("needs its own issue");
  const tools = (await repositoryTools(db, item))!;
  expect(tools.definitions.map((tool) => tool.name)).toEqual(["list_repositories"]);
  expect((await tools.call("list_repositories", { after: "acme/web" })).text).toBe("ops/infra");
});

test("an item that is not in code mode or has no other repository gets no list", async () => {
  const answer = await setup({ mode: "answer" });
  expect(await repositoryNote(answer.db, answer.item)).toBeNull();
  expect(await repositoryTools(answer.db, answer.item)).toBeUndefined();
  const alone = await setup({ repositories: ["acme/app"] });
  expect(await repositoryNote(alone.db, alone.item)).toBeNull();
  expect(await repositoryTools(alone.db, alone.item)).toBeUndefined();
});

test("list_repositories pages by 100", async () => {
  const names = Array.from({ length: 150 }, (_, n) => `acme/r${String(n).padStart(3, "0")}`);
  const { db, item } = await setup({ repositories: names });
  const note = (await repositoryNote(db, item))!;
  expect(note).toContain('More: list_repositories with after: "acme/r099"');
  expect(note).not.toContain("acme/r100");
  const page = (await (await repositoryTools(db, item))!.call("list_repositories", {
    after: "acme/r099",
  }))!.text.split("\n");
  expect(page).toHaveLength(50);
  expect(page[0]).toBe("acme/r100");
});

test("granted returns the default branch commit for a listed repository and journals it", async () => {
  const { granted, runId, lines } = await setup();
  expect(await granted(runId, "acme/web")).toEqual({ commit: SHA });
  expect(lines).toEqual([
    `run repository-grant item=item run=${runId} repository=acme/web commit=${SHA}`,
  ]);
});

test("granted refuses an unlisted repository, another mode, a removed one and an error", async () => {
  const { db, granted, runId, reader, lines } = await setup();
  expect(await granted(runId, "other/secret")).toBeNull();
  expect(await granted(runId, "acme/app")).toBeNull();
  expect(await granted("missing", "acme/web")).toBeNull();
  await db.run((q) =>
    q.exec(
      q.orm
        .delete(q.t.workspaceRepository)
        .where(
          and(
            eq(q.t.workspaceRepository.workspaceId, "ws"),
            eq(q.t.workspaceRepository.repository, "acme/docs"),
          ),
        ),
    ),
  );
  expect(await granted(runId, "acme/docs")).toBeNull();
  reader.resolve = () => Promise.reject(new Error("GitHub is down"));
  expect(await granted(runId, "acme/web")).toBeNull();
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.workItemTask)
        .set({ mode: "answer" })
        .where(eq(q.t.workItemTask.itemId, "item")),
    ),
  );
  reader.resolve = () => Promise.reject(new Error("must not be called"));
  expect(await granted(runId, "acme/web")).toBeNull();
  expect(lines.filter((line) => line.startsWith("run repository-grant"))).toEqual([]);
});
