import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  advanceMemberVmStepSteps,
  beginMemberVmDeleteSteps,
  cancelMemberVmJobsSteps,
  enqueueJobSteps,
  failMemberVmStepSteps,
  insertMemberVmSteps,
  memberVmByIdSteps,
  memberVmForMemberSteps,
  memberVmNameTakenSteps,
  openMemberVmJobSteps,
  recordMemberVmEnrollmentSteps,
  releaseRevokedMemberVmRunnerSteps,
  restoreMemberVmCreateRequestSteps,
  retryMemberVmDeleteSteps,
  retryMemberVmStepSteps,
  returnMemberVmToEnrollSteps,
  setMemberVmPoolSteps,
  updateMemberVmStepSteps,
  workspaceMemberVmsSteps,
  workspaceUserContactSteps,
  type Db,
  type MemberVm,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>): Promise<Db> {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function insertVm(db: Db, id: string, userId = "owner", now = 10) {
  return db.run((q) =>
    insertMemberVmSteps(q, {
      id,
      workspaceId: "acme",
      userId,
      vmName: `${id}-paws`,
      pool: null,
      now,
    }),
  );
}

function setVm(db: Db, id: string, fields: Record<string, unknown>) {
  return seed(db, (q) => q.orm.update(q.t.memberVm).set(fields).where(eq(q.t.memberVm.id, id)));
}

async function vm(db: Db, id: string): Promise<MemberVm> {
  const row = await db.run((q) => memberVmByIdSteps(q, id));
  if (row === null) throw new Error(`no member VM ${id}`);
  return row;
}

forEachDialect((connect) => {
  test("a new VM reads back by id, by member, by workspace and by name", async () => {
    const db = await connected(connect);
    await insertVm(db, "later", "second", 20);
    await insertVm(db, "first");
    await db.run((q) => setMemberVmPoolSteps(q, "first", "fleet", 30));

    expect(await vm(db, "first")).toMatchObject({
      workspaceId: "acme",
      userId: "owner",
      vmName: "first-paws",
      pool: "fleet",
      step: "create",
      stepStartedAt: 10,
      deleteAt: null,
      deleteBlocked: null,
      deleteForce: 0,
      enrollmentsTracked: 1,
      updatedAt: 30,
    });
    expect(await db.run((q) => memberVmByIdSteps(q, "missing"))).toBeNull();
    expect((await db.run((q) => memberVmForMemberSteps(q, "acme", "second")))?.id).toBe("later");
    expect(await db.run((q) => memberVmForMemberSteps(q, "acme", "nobody"))).toBeNull();
    const listed = await db.run((q) => workspaceMemberVmsSteps(q, "acme"));
    expect(listed.map((row) => row.id)).toEqual(["first", "later"]);
    expect(await db.run((q) => memberVmNameTakenSteps(q, "first-paws"))).toBe(true);
    expect(await db.run((q) => memberVmNameTakenSteps(q, "free-paws"))).toBe(false);
  });

  test("a step's writes hold only while the VM is on that step and not failed", async () => {
    const db = await connected(connect);
    await insertVm(db, "vm");
    const update = (step: string) =>
      db.run((q) =>
        updateMemberVmStepSteps(q, {
          id: "vm",
          step,
          fields: { createRequestedAt: 40, tokenExpiresAt: null },
          now: 41,
        }),
      );

    expect(await update("install")).toBe(0);
    expect(await update("create")).toBe(1);
    expect(await vm(db, "vm")).toMatchObject({ createRequestedAt: 40, updatedAt: 41 });

    await db.run((q) => restoreMemberVmCreateRequestSteps(q, "vm", null));
    expect(await vm(db, "vm")).toMatchObject({ createRequestedAt: null, updatedAt: 41 });

    const advance = (from: string) =>
      db.run((q) => advanceMemberVmStepSteps(q, { id: "vm", from, to: "install", now: 50 }));
    expect(await advance("enroll")).toBe(0);
    expect(await advance("create")).toBe(1);
    expect(await vm(db, "vm")).toMatchObject({
      step: "install",
      stepStartedAt: 50,
      installAt: 50,
      updatedAt: 50,
    });

    await db.run((q) =>
      failMemberVmStepSteps(q, { id: "vm", step: "create", failure: "no", now: 60 }),
    );
    expect((await vm(db, "vm")).failure).toBeNull();
    await db.run((q) =>
      failMemberVmStepSteps(q, { id: "vm", step: "install", failure: "broke", now: 61 }),
    );
    expect(await vm(db, "vm")).toMatchObject({ failure: "broke", updatedAt: 61 });
    expect(await update("install")).toBe(0);
    expect(await advance("install")).toBe(0);

    await setVm(db, "vm", { failure: null, deleteStep: "drain" });
    await db.run((q) =>
      failMemberVmStepSteps(q, { id: "vm", step: "install", failure: "late", now: 62 }),
    );
    expect((await vm(db, "vm")).failure).toBeNull();
  });

  test("a retry returns an unenrolled health failure to enroll and restarts an install", async () => {
    const db = await connected(connect);
    await insertVm(db, "health");
    await setVm(db, "health", { step: "health", failure: "gone", enrollAt: 1, healthAt: 2 });
    await insertVm(db, "kept", "kept");
    await setVm(db, "kept", {
      step: "health",
      failure: "slow",
      runnerId: "box",
      enrollAt: 1,
      healthAt: 2,
    });
    await insertVm(db, "install", "install");
    await setVm(db, "install", { step: "install", failure: "broke", installStartedAt: 3 });

    for (const id of ["health", "kept", "install"])
      await db.run((q) => retryMemberVmStepSteps(q, id, 90));

    expect(await vm(db, "health")).toMatchObject({
      step: "enroll",
      failure: null,
      enrollAt: 90,
      healthAt: null,
      stepStartedAt: 90,
      updatedAt: 90,
    });
    expect(await vm(db, "kept")).toMatchObject({
      step: "health",
      failure: null,
      enrollAt: 1,
      healthAt: 2,
    });
    expect(await vm(db, "install")).toMatchObject({
      step: "install",
      installStartedAt: null,
      failure: null,
    });
  });

  test("a revoked runner is released and the VM can enroll again", async () => {
    const db = await connected(connect);
    await seedRunner(db, "live");
    await seedRunner(db, "marked", { status: "revoked" });
    await seedRunner(db, "stamped", { revokedAt: 5 });
    for (const [id, runnerId] of [
      ["keeps", "live"],
      ["marked-vm", "marked"],
      ["stamped-vm", "stamped"],
    ] as const) {
      await insertVm(db, id, id);
      await setVm(db, id, { runnerId, step: "ready", tokenExpiresAt: 9, healthAt: 1, readyAt: 2 });
      await db.run((q) => releaseRevokedMemberVmRunnerSteps(q, "acme", id, 70));
    }

    expect(await vm(db, "keeps")).toMatchObject({ runnerId: "live", updatedAt: 10 });
    expect(await vm(db, "marked-vm")).toMatchObject({ runnerId: null, updatedAt: 70 });
    expect(await vm(db, "stamped-vm")).toMatchObject({ runnerId: null, updatedAt: 70 });

    await db.run((q) => returnMemberVmToEnrollSteps(q, "marked-vm", 80));
    expect(await vm(db, "marked-vm")).toMatchObject({
      step: "enroll",
      stepStartedAt: 80,
      tokenExpiresAt: null,
      enrollAt: 80,
      healthAt: null,
      readyAt: null,
      updatedAt: 80,
    });
  });

  test("a delete starts once and a retry only raises the force flag", async () => {
    const db = await connected(connect);
    await insertVm(db, "vm");
    await setVm(db, "vm", { runnerId: "box", deleteFailure: "old" });
    await db.run((q) =>
      beginMemberVmDeleteSteps(q, { id: "vm", requestedBy: "admin", force: 0, now: 100 }),
    );
    const begun = await vm(db, "vm");
    expect(begun).toMatchObject({
      deleteStep: "drain",
      deleteRunnerId: "box",
      deleteRequestedBy: "admin",
      deleteForce: 0,
      deleteStepStartedAt: 100,
      deleteFailure: null,
      updatedAt: 100,
    });
    expect(JSON.parse(begun.deleteAt!)).toEqual({ drain: 100 });

    await setVm(db, "vm", { deleteFailure: "busy" });
    await db.run((q) => retryMemberVmDeleteSteps(q, "vm", 1, 120));
    expect(await vm(db, "vm")).toMatchObject({
      deleteFailure: null,
      deleteBlocked: null,
      deleteForce: 1,
      deleteStepStartedAt: 120,
      updatedAt: 120,
    });
    await db.run((q) => retryMemberVmDeleteSteps(q, "vm", 0, 121));
    expect((await vm(db, "vm")).deleteForce).toBe(1);
  });

  test("an enrollment token is recorded once", async () => {
    const db = await connected(connect);
    const record = (now: number) =>
      db.run((q) => recordMemberVmEnrollmentSteps(q, { tokenHash: "hash", memberVmId: "vm", now }));
    await record(1);
    await record(2);
    const rows = await db.run(function* (q) {
      const { memberVmEnrollment: m } = q.t;
      return yield* q.all(
        q.orm.select({ memberVmId: m.memberVmId, createdAt: m.createdAt }).from(m),
      );
    });
    expect(rows).toEqual([{ memberVmId: "vm", createdAt: 1 }]);
  });

  test("a member VM's jobs are found by payload and cancelled by status", async () => {
    const db = await connected(connect);
    const enqueue = (queue: string, memberVmId: string) =>
      db.run((q) => enqueueJobSteps(q, { queue, payload: { memberVmId }, now: 1 }));
    const pending = await enqueue("provision", "vm");
    const running = await enqueue("provision", "busy");
    const other = await enqueue("provision", "other");
    await seed(db, (q) =>
      q.orm
        .update(q.t.job)
        .set({ status: "running", lockedBy: "worker", lockedUntil: 100 })
        .where(eq(q.t.job.id, running)),
    );
    const open = (queue: string, id: string) => db.run((q) => openMemberVmJobSteps(q, queue, id));

    expect(await open("provision", "vm")).toBe(true);
    expect(await open("provision", "busy")).toBe(true);
    expect(await open("provision", "none")).toBe(false);
    expect(await open("delete", "vm")).toBe(false);

    await db.run((q) =>
      cancelMemberVmJobsSteps(q, {
        queue: "provision",
        memberVmId: "busy",
        statuses: ["pending"],
        now: 200,
      }),
    );
    await db.run((q) =>
      cancelMemberVmJobsSteps(q, {
        queue: "provision",
        memberVmId: "vm",
        statuses: ["pending", "running"],
        now: 200,
      }),
    );
    const jobs = await db.run(function* (q) {
      const { job } = q.t;
      return yield* q.all(
        q.orm
          .select({
            id: job.id,
            status: job.status,
            finishedAt: job.finishedAt,
            lockedBy: job.lockedBy,
            lastError: job.lastError,
          })
          .from(job)
          .orderBy(job.id),
      );
    });
    expect(jobs).toEqual([
      {
        id: pending,
        status: "cancelled",
        finishedAt: 200,
        lockedBy: null,
        lastError: "member VM deleted",
      },
      { id: running, status: "running", finishedAt: null, lockedBy: "worker", lastError: null },
      { id: other, status: "pending", finishedAt: null, lockedBy: null, lastError: null },
    ]);
  });

  test("a user's contact details", async () => {
    const db = await connected(connect);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "u1", linearUserId: "l1", name: "Ada", email: "ada@example.com" }),
    );
    expect(await db.run((q) => workspaceUserContactSteps(q, "u1"))).toEqual({
      name: "Ada",
      email: "ada@example.com",
    });
    expect(await db.run((q) => workspaceUserContactSteps(q, "u2"))).toBeNull();
  });
});
