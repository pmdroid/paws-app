import { afterEach, expect, test } from "bun:test";
import { insertIssueVmGrantSteps, issueVmByIdSteps, type Db, type IssueVmState } from "../src/db";
import { seedSettings } from "./saved-settings";
import { issueVmAdmissionSteps, recordIssueVmSteps, setIssueVmStateSteps } from "../src/issue-vm";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<PgliteTestDb>): Promise<Db> {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function record(db: Db, id: string, member = "ada", itemId = `item-${id}`) {
  return db.run((q) =>
    recordIssueVmSteps(q, {
      id,
      workspaceId: "acme",
      itemId,
      memberUserId: member,
      provider: "exe-dev",
      now: NOW,
    }),
  );
}

function move(db: Db, id: string, state: IssueVmState, now = NOW + 1) {
  return db.run((q) => setIssueVmStateSteps(q, { id, state, now }));
}

function admit(db: Db, member = "ada", at = NOW) {
  return db.run((q) =>
    issueVmAdmissionSteps(q, { workspaceId: "acme", memberUserId: member, provider: "host", at }),
  );
}

describePglite((connect) => {
  test("sleeping VMs count against the member limit until one is deleted", async () => {
    const db = await connected(connect);
    expect(await admit(db)).toEqual({ ok: true });
    await record(db, "one");
    await record(db, "two");
    expect(await move(db, "one", "awake")).toEqual({ ok: true });
    expect(await move(db, "two", "asleep")).toEqual({ ok: true });
    expect(await admit(db)).toEqual({ ok: false, reason: "member_limit", limit: 2, inUse: 2 });
    expect(await admit(db, "grace")).toEqual({ ok: true });

    expect(await move(db, "two", "deleted", NOW + 5)).toEqual({ ok: true });
    const deleted = await db.run((q) => issueVmByIdSteps(q, "two"));
    expect(deleted).toMatchObject({ state: "deleted", stateAt: NOW + 5, deletedAt: NOW + 5 });
    expect(await admit(db)).toEqual({ ok: true });
  });

  test("a grant raises the member limit until it ends or is revoked", async () => {
    const db = await connected(connect);
    for (const id of ["a", "b", "c"]) await record(db, id);
    expect(await admit(db)).toMatchObject({ ok: false, reason: "member_limit", limit: 2 });
    await db.run((q) =>
      insertIssueVmGrantSteps(q, {
        id: "grant",
        workspaceId: "acme",
        memberUserId: "ada",
        limit: 4,
        endsAt: NOW + DAY,
        grantedBy: "admin",
        now: NOW,
      }),
    );
    expect(await admit(db)).toEqual({ ok: true });
    await record(db, "d");
    expect(await admit(db)).toEqual({ ok: false, reason: "member_limit", limit: 4, inUse: 4 });
    expect(await admit(db, "ada", NOW + DAY)).toEqual({
      ok: false,
      reason: "member_limit",
      limit: 2,
      inUse: 4,
    });
  });

  test("the workspace ceiling refuses a member under their own limit", async () => {
    const db = await connected(connect);
    await seedSettings(db, "[issue_vm]\nworkspace_max = 3\n");
    await record(db, "a", "ada");
    await record(db, "b", "grace");
    await record(db, "c", "linus");
    await record(db, "gone", "linus");
    await move(db, "gone", "failed");
    expect(await admit(db, "margaret")).toEqual({
      ok: false,
      reason: "workspace_limit",
      limit: 3,
      inUse: 3,
    });
  });

  test("an item has one live VM, and an ended VM never moves again", async () => {
    const db = await connected(connect);
    await record(db, "first", "ada", "item");
    const refused = await record(db, "second", "ada", "item").catch((error: Error) => error);
    expect(String((refused as Error).cause ?? refused)).toContain("issue_vm_item_live");
    await move(db, "first", "failed");
    expect(await move(db, "first", "awake")).toEqual({
      ok: false,
      reason: "ended",
      state: "failed",
    });
    await record(db, "second", "ada", "item");
    await move(db, "second", "deleted");
    expect(await move(db, "second", "deleting")).toEqual({
      ok: false,
      reason: "ended",
      state: "deleted",
    });
    expect(await move(db, "missing", "awake")).toEqual({ ok: false, reason: "missing" });
  });
});
