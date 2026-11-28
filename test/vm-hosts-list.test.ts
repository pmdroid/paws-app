import { afterEach, expect, test } from "bun:test";
import {
  insertIssueVmGrantSteps,
  insertIssueVmSteps,
  recordRunnerHostStatusSteps,
  saveVmHostSteps,
  type Db,
} from "../src/db";
import { handleVmHostsListRequest, type WorkspaceVmHostsView } from "../src/vm-hosts";
import type { WorkspacePrincipal } from "../src/workspace";
import { withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const GIB = 1024 ** 3;
const NOW = 1_000_000_000;
const LIVE = "01JRRNNER0000000000000000A";
const GONE = "01JRRNNER0000000000000000B";
const SIZE = {
  vmVcpus: 2,
  vmMemoryGb: 4,
  vmDiskGb: 30,
  reserveVcpus: 4,
  reserveMemoryGb: 8,
  slotCap: null,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  await withoutForeignKeys(db);
  await db.transaction(function* (q) {
    for (const [id, name, active, revokedAt] of [
      ["grace", "Grace", 1, null],
      ["ada", "Ada", 1, null],
      ["linus", "Linus", 0, null],
      ["ken", "Ken", 1, 5],
    ] as const) {
      yield* q.exec(
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id, linearUserId: `linear-${id}`, name, email: `${id}@acme.test` }),
      );
      yield* q.exec(
        q.orm.insert(q.t.workspaceMember).values({
          workspaceId: "acme",
          userId: id,
          role: id === "grace" ? "admin" : "member",
          source: "linear",
          active,
          revokedAt,
          checkedAt: 0,
        }),
      );
    }
    for (const [id, name, lastSeenAt] of [
      [LIVE, "goldbox", NOW - 1_000],
      [GONE, "silverbox", NOW - 600_000],
    ] as const) {
      yield* q.exec(
        q.orm.insert(q.t.runner).values({
          id,
          workspaceId: "acme",
          ownerUserId: "grace",
          name,
          status: "active",
          createdAt: 0,
          lastSeenAt,
        }),
      );
      yield* recordRunnerHostStatusSteps(q, id, { cpuCount: 20, memoryTotalBytes: 121 * GIB }, 1);
      yield* saveVmHostSteps(q, { ...SIZE, runnerId: id, updatedAt: 1, updatedBy: "grace" });
    }
    yield* insertIssueVmSteps(q, {
      workspaceId: "acme",
      itemId: "item-1",
      memberUserId: "ada",
      provider: "host",
      hostRunnerId: LIVE,
      now: 1,
    });
  });
  return db;
}

function call(db: Db, userId: string, method = "GET") {
  const principal = {
    workspaceId: "acme",
    userId,
    role: "member",
    authenticatedAt: 0,
    teamIds: [],
  } as WorkspacePrincipal;
  return handleVmHostsListRequest(new Request("http://127.0.0.1:8787/api/vm-hosts", { method }), {
    db,
    principal,
    now: () => NOW,
  }) as Promise<Response>;
}

test("a member sees every VM host with its slots, offline ones too, and their own grant", async () => {
  const db = await store();
  const before = (await (await call(db, "ada")).json()) as WorkspaceVmHostsView;
  expect(before).toEqual({
    hosts: [
      {
        id: LIVE,
        name: "goldbox",
        status: "active",
        online: true,
        slots: { used: 1, total: 8 },
        vm: { vcpus: 2, memoryGb: 4, diskGb: 30 },
        addedBy: "Grace",
      },
      {
        id: GONE,
        name: "silverbox",
        status: "active",
        online: false,
        slots: { used: 0, total: 8 },
        vm: { vcpus: 2, memoryGb: 4, diskGb: 30 },
        addedBy: "Grace",
      },
    ],
    grant: null,
  });

  await db.run((q) =>
    insertIssueVmGrantSteps(q, {
      workspaceId: "acme",
      memberUserId: "ada",
      limit: 3,
      endsAt: NOW + 86_400_000,
      grantedBy: "grace",
      now: 2,
    }),
  );
  const granted = (await (await call(db, "ada")).json()) as WorkspaceVmHostsView;
  expect(granted.grant).toEqual({ limit: 3, endsAt: NOW + 86_400_000, running: 1 });
  expect(((await (await call(db, "grace")).json()) as WorkspaceVmHostsView).grant).toBeNull();
});

test("an inactive or removed member is refused, and only GET is allowed", async () => {
  const db = await store();
  expect((await call(db, "linus")).status).toBe(403);
  expect((await call(db, "ken")).status).toBe(403);
  expect((await call(db, "stranger")).status).toBe(403);
  expect((await call(db, "ada", "POST")).status).toBe(405);
});
