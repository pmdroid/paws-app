import { afterEach, expect, test } from "bun:test";
import type { Db, IssueVmProvider, Q, WorkspaceRole } from "../src/db";
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
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";

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
  const { db } = handle;
  await withoutForeignKeys(db);
  const people: [string, WorkspaceRole][] = [
    ["admin", "admin"],
    ["ada", "member"],
  ];
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    ...people.map(
      ([id]) =>
        (q: Q) =>
          q.orm
            .insert(q.t.workspaceUser)
            .values({ id, linearUserId: `linear-${id}`, name: id, email: `${id}@acme.test` }),
    ),
    ...people.map(
      ([id, role]) =>
        (q: Q) =>
          q.orm.insert(q.t.workspaceMember).values({
            workspaceId: "acme",
            userId: id,
            role,
            source: "linear",
            active: 1,
            checkedAt: 0,
          }),
    ),
  );
  return db;
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
    expect(await response!.json()).toEqual({
      monthlyLimitUsd: 50,
      prices: { boat: null, instabox: null },
      month: "2026-11",
      spentUsd: 0,
    });
    expect(await start(db, "boat", NOV)).toEqual({
      ok: false,
      reason: "no_price",
      provider: "boat",
      message: "No hourly price is set for boat issue VMs",
    });
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
    const refused = {
      ok: false,
      reason: "spend_limit",
      spentUsd: 4,
      limitUsd: 4,
      message: "Monthly issue VM spend limit reached ($4.00 of $4.00)",
    } as const;
    expect(await start(db, "boat", at)).toEqual(refused);
    expect(await start(db, "instabox", at)).toEqual(refused);
    expect(await wake(db, "boat", at)).toEqual(refused);
    expect(await start(db, "host", at)).toEqual({ ok: true });
    expect(await wake(db, "host", at)).toEqual({ ok: true });

    const raised = await call(db, "PUT", { body: { monthlyLimitUsd: 10 }, at });
    expect(await raised!.json()).toEqual({
      monthlyLimitUsd: 10,
      prices: { boat: 2, instabox: 1 },
      month: "2026-11",
      spentUsd: 4,
    });
    expect(await start(db, "boat", at)).toEqual({ ok: true });
    expect(await wake(db, "boat", at)).toEqual({ ok: true });
  });

  test("only admins read or set the spend limit, and bad values are refused", async () => {
    const db = await connected(connect);
    expect((await call(db, "GET", { role: "member" }))?.status).toBe(403);
    expect(
      (await call(db, "PUT", { role: "member", body: { monthlyLimitUsd: 500 } }))?.status,
    ).toBe(403);
    for (const body of [
      { monthlyLimitUsd: -1 },
      { monthlyLimitUsd: null },
      { prices: { boat: "1" } },
      { prices: { "exe-dev": 1 } },
    ])
      expect((await call(db, "PUT", { body }))?.status).toBe(400);
    expect((await call(db, "POST", { body: {} }))?.status).toBe(405);
    const cleared = await call(db, "PUT", { body: { prices: { boat: 3 } } });
    expect(await cleared!.json()).toMatchObject({ prices: { boat: 3, instabox: null } });
    const unpriced = await call(db, "PUT", { body: { prices: { boat: null } } });
    expect(await unpriced!.json()).toMatchObject({ monthlyLimitUsd: 50, prices: { boat: null } });
  });
});
