import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db, IssueVmProvider, WorkspaceRole } from "../src/db";
import {
  handleIssueVmGrantRequest,
  issueVmAdmissionSteps,
  issueVmSpendSteps,
  issueVmWakeAdmissionSteps,
  markIssueVmAsleepSteps,
  markIssueVmAwakeSteps,
  recordIssueVmSteps,
  setIssueVmStateSteps,
} from "../src/issue-vm";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

const HOUR = 3_600_000;
const NOV = Date.UTC(2026, 10, 1);
const ORIGIN = "http://127.0.0.1:8787";

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

function call(
  db: Db,
  method: string,
  options: { body?: unknown; role?: WorkspaceRole; at?: number } = {},
) {
  return handleIssueVmGrantRequest(
    new Request(`${ORIGIN}/api/settings/issue-vm/spend`, {
      method,
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    {
      db,
      csrfToken: "csrf",
      now: () => options.at ?? NOV + 14 * 24 * HOUR,
      principal: {
        workspaceId: "acme",
        userId: options.role === "member" ? "ada" : "admin",
        role: options.role ?? "admin",
        authenticatedAt: 0,
        teamIds: [],
      },
    },
  );
}

async function awake(db: Db, id: string, provider: IssueVmProvider, from: number, to?: number) {
  await db.run((q) =>
    recordIssueVmSteps(q, {
      id,
      workspaceId: "acme",
      itemId: `item-${id}`,
      memberUserId: `owner-${id}`,
      provider,
      now: from,
    }),
  );
  expect(await db.run((q) => markIssueVmAwakeSteps(q, { id, now: from }))).toEqual({ ok: true });
  if (to !== undefined)
    expect(await db.run((q) => markIssueVmAsleepSteps(q, { id, now: to }))).toEqual({ ok: true });
}

function start(db: Db, provider: IssueVmProvider, at: number) {
  return db.run((q) =>
    issueVmAdmissionSteps(q, { workspaceId: "acme", memberUserId: "ada", provider, at }),
  );
}

function wake(db: Db, provider: IssueVmProvider, at: number) {
  return db.run((q) => issueVmWakeAdmissionSteps(q, { workspaceId: "acme", provider, at }));
}

function spent(db: Db, at: number) {
  return db.run((q) => issueVmSpendSteps(q, { workspaceId: "acme", at }));
}

describePglite((connect) => {
  test("a cloud provider without a price cannot start, while a host microVM can", async () => {
    const db = await connected(connect);
    const response = await call(db, "GET");
    expect(response?.status).toBe(200);
    const body = {
      monthlyLimitUsd: 50,
      prices: { boat: null, instabox: null },
      snapshots: { boat: null, instabox: null },
    };
    expect(await response!.json()).toEqual({ ...body, month: "2026-11", spentUsd: 0 });
    const message = "No hourly price is set for boat issue VMs";
    const refused = { ok: false, reason: "no_price", provider: "boat", message } as const;
    expect(await start(db, "boat", NOV)).toEqual(refused);
    expect(await wake(db, "instabox", NOV)).toMatchObject({ ok: false, reason: "no_price" });
    expect(await start(db, "host", NOV)).toEqual({ ok: true });
  });

  test("spend counts awake hours inside each UTC calendar month", async () => {
    const db = await connected(connect);
    const saved = await call(db, "PUT", { body: { prices: { boat: 2, instabox: 0.5 } } });
    expect(saved?.status).toBe(200);
    await awake(db, "edge", "boat", NOV - HOUR, NOV + 2 * HOUR);
    await awake(db, "box", "instabox", NOV + 10 * HOUR);
    await awake(db, "local", "host", NOV, NOV + 100 * HOUR);

    expect((await spent(db, NOV - HOUR / 2)).spentUsd).toBe(1);
    expect(await spent(db, NOV - 1)).toMatchObject({ month: "2026-10" });
    expect(await spent(db, NOV + 14 * HOUR)).toMatchObject({ month: "2026-11", spentUsd: 6 });
    expect((await spent(db, Date.UTC(2026, 11, 1) + 2 * HOUR)).spentUsd).toBe(1);

    await db.run((q) =>
      setIssueVmStateSteps(q, { id: "box", state: "deleted", now: NOV + 12 * HOUR }),
    );
    expect((await spent(db, NOV + 14 * HOUR)).spentUsd).toBe(5);
  });

  test("at the limit cloud starts and wakes wait, host microVMs start, and a raise lets them go", async () => {
    const db = await connected(connect);
    await call(db, "PUT", { body: { monthlyLimitUsd: 4, prices: { boat: 2, instabox: 1 } } });
    const at = NOV + 5 * HOUR;
    await awake(db, "one", "boat", NOV + HOUR, NOV + 2 * HOUR);
    expect(await start(db, "boat", at)).toEqual({ ok: true });
    expect(await wake(db, "instabox", at)).toEqual({ ok: true });

    await awake(db, "two", "boat", NOV + 3 * HOUR, NOV + 4 * HOUR);
    const message = "Monthly issue VM spend limit reached ($4.00 of $4.00)";
    const refused = {
      ok: false,
      reason: "spend_limit",
      spentUsd: 4,
      limitUsd: 4,
      message,
    } as const;
    expect(await start(db, "boat", at)).toEqual(refused);
    expect(await start(db, "instabox", at)).toEqual(refused);
    expect(await wake(db, "boat", at)).toEqual(refused);
    expect(await start(db, "host", at)).toEqual({ ok: true });
    expect(await wake(db, "host", at)).toEqual({ ok: true });

    const raised = await call(db, "PUT", { body: { monthlyLimitUsd: 10 }, at });
    expect(await raised!.json()).toMatchObject({ monthlyLimitUsd: 10, spentUsd: 4 });
    expect(await start(db, "boat", at)).toEqual({ ok: true });
    expect(await wake(db, "boat", at)).toEqual({ ok: true });
  });

  test("members read the spend, only admins set it, and bad values are refused", async () => {
    const db = await connected(connect);
    const read = await call(db, "GET", { role: "member" });
    expect(read?.status).toBe(200);
    expect(await read!.json()).toMatchObject({ monthlyLimitUsd: 50, spentUsd: 0 });
    expect(
      (await call(db, "PUT", { role: "member", body: { monthlyLimitUsd: 500 } }))?.status,
    ).toBe(403);
    for (const body of [
      { monthlyLimitUsd: -1 },
      { monthlyLimitUsd: null },
      { prices: { boat: "1" } },
      { prices: { "exe-dev": 1 } },
      { prices: { boat: null } },
      { snapshots: { boat: "has space" } },
      { snapshots: { instabox: "paws.base" } },
      { snapshots: { "exe-dev": "paws-base" } },
      { snapshots: "paws-base" },
      {},
    ])
      expect((await call(db, "PUT", { body }))?.status).toBe(400);
    expect((await call(db, "POST", { body: {} }))?.status).toBe(405);
    const priced = await call(db, "PUT", { body: { prices: { boat: 3 } } });
    expect(await priced!.json()).toMatchObject({
      monthlyLimitUsd: 50,
      prices: { boat: 3, instabox: null },
    });
    await call(db, "PUT", { body: { monthlyLimitUsd: 20 } });
    const both = await call(db, "PUT", { body: { prices: { instabox: 1 } } });
    expect(await both!.json()).toMatchObject({
      monthlyLimitUsd: 20,
      prices: { boat: 3, instabox: 1 },
    });
    const named = await call(db, "PUT", {
      body: { snapshots: { boat: " paws.base ", instabox: "snap_paws" } },
    });
    expect(await named!.json()).toMatchObject({
      prices: { boat: 3, instabox: 1 },
      snapshots: { boat: "paws.base", instabox: "snap_paws" },
    });
    const cleared = await call(db, "PUT", { body: { snapshots: { boat: "", instabox: null } } });
    expect(await cleared!.json()).toMatchObject({ snapshots: { boat: null, instabox: null } });
  });

  test("an awake interval keeps the price it started with", async () => {
    const db = await connected(connect);
    await call(db, "PUT", { body: { monthlyLimitUsd: 4, prices: { boat: 2, instabox: 1 } } });
    await awake(db, "one", "boat", NOV, NOV + 2 * HOUR);
    await call(db, "PUT", { body: { prices: { boat: 0 } } });
    expect((await spent(db, NOV + 3 * HOUR)).spentUsd).toBe(4);
    expect(await start(db, "instabox", NOV + 3 * HOUR)).toMatchObject({ reason: "spend_limit" });
  });

  test("spend that adds up to the limit reaches it despite floating point", async () => {
    const db = await connected(connect);
    await call(db, "PUT", { body: { monthlyLimitUsd: 1, prices: { boat: 0.1 } } });
    for (let hour = 0; hour < 10; hour += 1)
      await awake(db, `vm-${hour}`, "boat", NOV + hour * HOUR, NOV + (hour + 1) * HOUR);
    expect((await spent(db, NOV + 20 * HOUR)).spentUsd).toBe(1);
    expect(await wake(db, "boat", NOV + 20 * HOUR)).toMatchObject({ reason: "spend_limit" });
  });

  test("a VM being deleted keeps costing until it is deleted, and a retried delete closes it", async () => {
    const db = await connected(connect);
    await call(db, "PUT", { body: { prices: { boat: 1 } } });
    await awake(db, "gone", "boat", NOV);
    const move = (state: "deleting" | "deleted", now: number) =>
      db.run((q) => setIssueVmStateSteps(q, { id: "gone", state, now }));
    expect(await move("deleting", NOV + HOUR)).toEqual({ ok: true });
    expect((await spent(db, NOV + 3 * HOUR)).spentUsd).toBe(3);
    await db.run(function* (q) {
      yield* q.exec(
        q.orm
          .update(q.t.issueVm)
          .set({ state: "deleted", deletedAt: NOV + 3 * HOUR })
          .where(eq(q.t.issueVm.id, "gone")),
      );
    });
    expect(await move("deleted", NOV + 4 * HOUR)).toMatchObject({ ok: false, reason: "ended" });
    expect((await spent(db, NOV + 10 * HOUR)).spentUsd).toBe(4);
  });
});
