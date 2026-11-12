import { afterEach, expect, test } from "bun:test";
import { createRunnerControl } from "../src/runner-control";
import { tempDb } from "./helpers";
import { eq } from "drizzle-orm";
import {
  createRunnerEnrollmentSteps,
  enrollRunnerSteps,
  findRunnerEnrollmentSteps,
  getRunnerSteps,
  isCurrentRunnerCertificateSteps,
  listRunnerOverviewSteps,
  listRunnersSteps,
  recentRunnersSteps,
  recordRunnerAgentUsageSteps,
  recordRunnerHostStatusSteps,
  renewRunnerCertificateSteps,
  runnerAgentUsageSteps,
  runnerForCertificateSteps,
  runnerHostVersionSteps,
  runnerOwnerSteps,
  runnerStandingSteps,
  runnerTargetForRestoreSteps,
  runRunnerAvailabilitySteps,
  runRunnerNameSteps,
  runnerRepositoryListsSteps,
  storedRunnerNameSteps,
  updateRunnerStatusSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps, jsonValue, type DialectDb } from "./dialects";
import { insertRunnerSteps } from "./runner-dialect-seed";

const handles: DialectDb[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

const certificate = (fingerprint: string, notBefore = 0, notAfter = 1_000_000_000) => ({
  fingerprint,
  serial: `serial-${fingerprint}`,
  pem: "pem",
  notBefore,
  notAfter,
});

const NOW = 10_000_000;

function* insertWorkSteps(
  q: Q,
  runId: string,
  options: { status?: string; leaseUntil?: number; endedAt?: number; createdAt?: number } = {},
) {
  yield* insertWorkItemSteps(q, `item-${runId}`);
  yield* q.exec(
    q.orm.insert(q.t.run).values({
      id: runId,
      itemId: `item-${runId}`,
      kind: "work",
      agent: "claude",
      status: options.status ?? "active",
      createdAt: options.createdAt ?? 5,
      updatedAt: 5,
    }),
  );
  yield* q.exec(
    q.orm.insert(q.t.runnerWork).values({
      runId,
      runnerId: "box",
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil: options.leaseUntil ?? NOW + 1_000_000,
      endedAt: options.endedAt ?? null,
    }),
  );
}

function* insertEnrollmentSteps(q: Q) {
  yield* createRunnerEnrollmentSteps(q, {
    id: "enrollment",
    tokenHash: "token",
    workspaceId: "acme",
    userId: "owner",
    name: "laptop",
    expiresAt: NOW + 100,
    now: NOW,
  });
}

function* insertEnrollmentStepsWith(q: Q, id: string, tokenHash: string) {
  yield* createRunnerEnrollmentSteps(q, {
    id,
    tokenHash,
    workspaceId: "acme",
    userId: "owner",
    name: id,
    expiresAt: NOW + 100,
    now: NOW,
  });
}

function* enrollSteps(q: Q, runnerId = "paired", fingerprint = "first") {
  return yield* enrollRunnerSteps(q, {
    tokenHash: "token",
    runnerId,
    name: "laptop",
    certificate: certificate(fingerprint),
    now: NOW,
  });
}

const auditActions = (db: Db) =>
  db.run(function* (q) {
    const { workspaceAccessAudit: audit } = q.t;
    const rows = yield* q.all(q.orm.select({ action: audit.action }).from(audit));
    return rows.map((row) => row.action).sort();
  });

forEachDialect((connect) => {
  const open = async () => {
    const handle = await connect();
    handles.push(handle);
    return handle.db;
  };

  test("a runner's stored facts read back, listed oldest first", async () => {
    const db = await open();
    await db.run(function* (q) {
      yield* insertRunnerSteps(q, "later", "acme", 20);
      yield* insertRunnerSteps(q, "box", "acme", 10);
      yield* q.exec(q.orm.update(q.t.runner).set({ lastSeenAt: 900 }));
      yield* recordRunnerHostStatusSteps(q, "box", { runnerVersion: "1.2.3" }, 50);
    });

    const box = { id: "box", workspaceId: "acme", ownerUserId: "owner", name: "box" };
    expect(await db.run((q) => getRunnerSteps(q, "box"))).toEqual({
      ...box,
      status: "active",
      fence: 0,
    });
    expect(await db.run((q) => getRunnerSteps(q, "gone"))).toBeNull();
    expect((await db.run((q) => listRunnersSteps(q, "acme"))).map((row) => row.id)).toEqual([
      "box",
      "later",
    ]);
    expect(await db.run((q) => storedRunnerNameSteps(q, "box"))).toBe("box");
    expect(await db.run((q) => storedRunnerNameSteps(q, "gone"))).toBeNull();
    expect(await db.run((q) => runnerHostVersionSteps(q, "box"))).toBe("1.2.3");
    expect(await db.run((q) => runnerHostVersionSteps(q, "later"))).toBeNull();
    expect(await db.run((q) => runnerTargetForRestoreSteps(q, "box"))).toEqual({
      ownerUserId: "owner",
      version: "1.2.3",
    });
    expect(await db.run((q) => runnerTargetForRestoreSteps(q, "later"))).toEqual({
      ownerUserId: "owner",
      version: null,
    });
    expect(await db.run((q) => runnerStandingSteps(q, "box"))).toEqual({
      status: "active",
      revokedAt: null,
      lastSeenAt: 900,
    });
    expect(await db.run((q) => runnerOwnerSteps(q, "box"))).toEqual({
      workspaceId: "acme",
      userId: "owner",
    });
    expect(await db.run((q) => runnerOwnerSteps(q, "gone"))).toBeNull();
    expect(await db.run((q) => recentRunnersSteps(q, 800))).toEqual([
      { id: "box", workspaceId: "acme" },
      { id: "later", workspaceId: "acme" },
    ]);
    expect(await db.run((q) => recentRunnersSteps(q, 900))).toEqual([]);
  });

  test("a run's runner is named and its availability reported", async () => {
    const db = await open();
    await db.run(function* (q) {
      yield* insertRunnerSteps(q, "box");
      yield* insertWorkSteps(q, "run-1");
    });

    expect(await db.run((q) => runRunnerNameSteps(q, "run-1"))).toBe("box");
    expect(await db.run((q) => runRunnerNameSteps(q, "gone"))).toBeNull();
    expect(await db.run((q) => runRunnerAvailabilitySteps(q, "run-1"))).toEqual({
      id: "box",
      name: "box",
      status: "active",
      revoked: false,
      lastSeenAt: null,
    });
    expect(await db.run((q) => runRunnerAvailabilitySteps(q, "gone"))).toBeNull();
  });

  test("a runner with no capacity report has one slot and no host sample", async () => {
    const db = await open();
    await db.run((q) => insertRunnerSteps(q, "box"));

    const [runner] = await db.run((q) => listRunnerOverviewSteps(q, "acme", NOW));
    expect(runner).toMatchObject({
      ownerName: "Ada",
      hasRunWork: false,
      metrics: null,
      os: null,
      version: null,
      agentUser: null,
      idle: true,
      slots: { used: 0, total: 1 },
      concurrency: null,
      conversations: null,
      running: [],
    });
  });

  test("a pending command makes a runner busy, and only work commands count as run work", async () => {
    const db = await open();
    await db.run(function* (q) {
      yield* insertRunnerSteps(q, "box");
      yield* q.exec(
        q.orm.insert(q.t.runnerCommand).values({
          id: "probe",
          runnerId: "box",
          kind: "probe",
          envelope: jsonValue(q, {}),
          expiresAt: NOW + 10,
        }),
      );
    });
    const before = await db.run((q) => listRunnerOverviewSteps(q, "acme", NOW));
    expect(before[0]).toMatchObject({ idle: false, hasRunWork: false });
    const expired = await db.run((q) => listRunnerOverviewSteps(q, "acme", NOW + 10));
    expect(expired[0]!.idle).toBe(true);

    await db.run(function* (q) {
      yield* q.exec(
        q.orm.insert(q.t.runnerCommand).values({
          id: "run",
          runnerId: "box",
          kind: "run",
          envelope: jsonValue(q, {}),
          expiresAt: 0,
        }),
      );
    });
    const after = await db.run((q) => listRunnerOverviewSteps(q, "acme", NOW + 10));
    expect(after[0]).toMatchObject({ idle: true, hasRunWork: true });
  });

  test("the overview reports host numbers, slots and each session's phase", async () => {
    const db = await open();
    await db.run(function* (q) {
      const { closeoutProgress, linearSession, runnerCapacity, runnerHelper, workItem } = q.t;
      yield* insertRunnerSteps(q, "box");
      yield* recordRunnerHostStatusSteps(q, "box", { cpuPercent: 1 }, 40);
      yield* recordRunnerHostStatusSteps(
        q,
        "box",
        {
          cpuPercent: 12.5,
          cpuCount: 8,
          memoryTotalBytes: 16,
          osId: "ubuntu",
          runnerVersion: "0.0.1",
          strayProcesses: [{ pid: 7, name: "vim", ageSeconds: 3, cpuPercent: 0.5 }],
        },
        50,
      );
      yield* q.exec(
        q.orm
          .insert(runnerCapacity)
          .values({ runnerId: "box", capacity: 8, ceiling: 10, desired: 2, conversation: 3 }),
      );
      yield* insertWorkSteps(q, "run-1", { createdAt: 1 });
      yield* insertWorkSteps(q, "run-2", { createdAt: 2, leaseUntil: 0 });
      yield* insertWorkSteps(q, "run-3", { createdAt: 3 });
      yield* insertWorkSteps(q, "run-4", { createdAt: 4 });
      yield* insertWorkSteps(q, "run-ended", { createdAt: 5, status: "ended", endedAt: 6 });
      yield* q.exec(
        q.orm.update(workItem).set({ state: "verifying" }).where(eq(workItem.id, "item-run-1")),
      );
      yield* q.exec(
        q.orm
          .update(workItem)
          .set({ checkpoint: jsonValue(q, { phase: "merge_queue" }) })
          .where(eq(workItem.id, "item-run-2")),
      );
      const progress = (id: string, itemId: string, decision: string, updatedAt: number) => ({
        id,
        itemId,
        taskId: "task",
        base: "base",
        head: "head",
        policyDigest: "digest",
        decision,
        startedAt: 1,
        updatedAt,
      });
      yield* q.exec(
        q.orm
          .insert(closeoutProgress)
          .values([
            progress("p1", "item-run-3", "accepted", 9),
            progress("p2", "item-run-3", "rejected", 9),
            progress("p3", "item-run-4", "rejected", 8),
            progress("p4", "item-run-4", "accepted", 9),
          ]),
      );
      yield* q.exec(
        q.orm.insert(q.t.runnerSessionMove).values({
          runId: "run-4",
          runnerId: "box",
          status: "waiting",
          reason: "busy",
          updatedAt: 1,
        }),
      );
      yield* q.exec(q.orm.insert(linearSession).values({ sessionId: "s", createdAt: 0 }));
      const helper = (id: string, purpose: string | null) => ({
        id,
        runnerId: "box",
        workspaceId: "acme",
        sessionId: "s",
        sessionGeneration: 1,
        runnerFence: 0,
        envelope: jsonValue(q, {}),
        expiresAt: NOW + 1_000,
        purpose,
      });
      yield* q.exec(
        q.orm
          .insert(runnerHelper)
          .values([helper("work", null), helper("conversation", "conversation")]),
      );
    });

    const [runner] = await db.run((q) => listRunnerOverviewSteps(q, "acme", NOW));
    expect(runner).toMatchObject({
      hasRunWork: true,
      idle: false,
      metrics: {
        cpuPercent: 12.5,
        cpuCount: 8,
        memoryTotalBytes: 16,
        memoryAvailableBytes: null,
        strayProcesses: [{ pid: 7, name: "vim", ageSeconds: 3, cpuPercent: 0.5 }],
        reportedAt: 50,
      },
      os: { id: "ubuntu", version: null },
      version: "0.0.1",
      agentUser: "runner",
      slots: { used: 5, total: 2 },
      concurrency: { desired: 2, applied: 8, ceiling: 10 },
      conversations: { used: 1, total: 3 },
      skills: [],
      runtimes: [],
      codingAgents: [],
    });
    expect(
      runner!.running.map(({ runId, phase, startedAt, movable, move }) => ({
        runId,
        phase,
        startedAt,
        movable,
        move,
      })),
    ).toEqual([
      { runId: "run-1", phase: "closeout", startedAt: 1, movable: true, move: null },
      { runId: "run-2", phase: "merging", startedAt: 2, movable: false, move: null },
      { runId: "run-3", phase: "fixing", startedAt: 3, movable: true, move: null },
      {
        runId: "run-4",
        phase: "working",
        startedAt: 4,
        movable: true,
        move: { status: "waiting", reason: "busy" },
      },
    ]);
    expect(runner!.running[0]).toMatchObject({
      identifier: "item-run-1",
      title: "item-run-1",
    });
  });

  test("an older usage report never replaces a newer one", async () => {
    const db = await open();
    const report = (usedPercent: number, observedAt: number) => ({
      runnerId: "box",
      agent: "claude",
      limits: [{ window: "5h", usedPercent, resetsAt: null }],
      observedAt,
    });
    await db.run((q) => insertRunnerSteps(q, "box"));
    expect(await db.run((q) => runnerAgentUsageSteps(q, "box", "claude"))).toBeNull();

    await db.run((q) => recordRunnerAgentUsageSteps(q, report(10, 100)));
    await db.run((q) => recordRunnerAgentUsageSteps(q, report(90, 50)));
    expect(await db.run((q) => runnerAgentUsageSteps(q, "box", "claude"))).toEqual({
      limits: [{ window: "5h", usedPercent: 10, resetsAt: null }],
      observedAt: 100,
    });
    await db.run((q) => recordRunnerAgentUsageSteps(q, report(20, 100)));
    expect((await db.run((q) => runnerAgentUsageSteps(q, "box", "claude")))!.limits[0]).toEqual({
      window: "5h",
      usedPercent: 20,
      resetsAt: null,
    });
  });

  test("an enrollment's starting repository list becomes the runner's page list", async () => {
    const db = await open();
    await db.run((q) => insertRunnerSteps(q, "box"));
    await db.transaction(function* (q) {
      yield* createRunnerEnrollmentSteps(q, {
        id: "dashboard",
        tokenHash: "token",
        workspaceId: "acme",
        userId: "owner",
        name: "laptop",
        expiresAt: NOW + 100,
        now: NOW,
        adminRepositories: [],
      });
      yield* insertEnrollmentStepsWith(q, "vm", "token-vm");
    });
    await db.transaction((q) => enrollSteps(q));
    await db.transaction(function* (q) {
      return yield* enrollRunnerSteps(q, {
        tokenHash: "token-vm",
        runnerId: "vm-runner",
        name: "vm",
        certificate: certificate("vm"),
        now: NOW,
      });
    });
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "paired"))).toEqual({
      admin: [],
      host: null,
    });
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "vm-runner"))).toEqual({
      admin: null,
      host: null,
    });
  });

  test("an enrollment pairs one runner once and refuses past the pending limit", async () => {
    const db = await open();
    await db.run((q) => insertRunnerSteps(q, "box"));
    await db.transaction(insertEnrollmentSteps);
    const enrollment = {
      id: "enrollment",
      workspaceId: "acme",
      userId: "owner",
      name: "laptop",
      expiresAt: NOW + 100,
      adminRepositories: null,
    };
    expect(await db.run((q) => findRunnerEnrollmentSteps(q, "token", NOW))).toEqual(enrollment);
    expect(await db.run((q) => findRunnerEnrollmentSteps(q, "token", NOW + 100))).toBeNull();

    expect(await db.transaction((q) => enrollSteps(q))).toEqual(enrollment);
    expect(await db.run((q) => getRunnerSteps(q, "paired"))).toEqual({
      id: "paired",
      workspaceId: "acme",
      ownerUserId: "owner",
      name: "laptop",
      status: "paused",
      fence: 0,
    });
    expect(await auditActions(db)).toEqual(["runner.paired"]);
    expect(await db.run((q) => findRunnerEnrollmentSteps(q, "token", NOW))).toBeNull();
    await expect(db.transaction((q) => enrollSteps(q, "again", "second"))).rejects.toThrow(
      "Runner enrollment is invalid or expired.",
    );

    await db.transaction(function* (q) {
      yield* createRunnerEnrollmentSteps(q, {
        id: "retry",
        tokenHash: "token-2",
        workspaceId: "acme",
        userId: "owner",
        name: "laptop",
        expiresAt: NOW + 100,
        now: NOW,
      });
    });
    await expect(
      db.transaction((q) =>
        enrollRunnerSteps(q, {
          tokenHash: "token-2",
          runnerId: "rolled-back",
          name: "laptop",
          certificate: certificate("first"),
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(await db.run((q) => getRunnerSteps(q, "rolled-back"))).toBeNull();
    expect(await db.run((q) => findRunnerEnrollmentSteps(q, "token-2", NOW))).not.toBeNull();

    const pending = (id: string, expiresAt: number, now: number) => ({
      id,
      tokenHash: `hash-${id}`,
      workspaceId: "acme",
      userId: "owner",
      name: id,
      expiresAt,
      now,
    });
    await db.transaction(function* (q) {
      for (let index = 0; index < 99; index += 1)
        yield* createRunnerEnrollmentSteps(q, pending(`n${index}`, NOW + 100, NOW));
    });
    await expect(
      db.transaction((q) => createRunnerEnrollmentSteps(q, pending("over", NOW + 100, NOW))),
    ).rejects.toThrow("Too many runner enrollments. Try again shortly.");
    await db.transaction((q) =>
      createRunnerEnrollmentSteps(q, pending("after-expiry", NOW + 200, NOW + 100)),
    );
    expect(await db.run((q) => findRunnerEnrollmentSteps(q, "hash-n0", NOW))).toBeNull();
    expect(
      await db.run((q) => findRunnerEnrollmentSteps(q, "hash-after-expiry", NOW)),
    ).not.toBeNull();
  });

  test("concurrent renewals accept only one successor of the same certificate", async () => {
    const db = await open();
    await db.run((q) => insertRunnerSteps(q, "box"));
    await db.transaction(insertEnrollmentSteps);
    await db.transaction((q) => enrollSteps(q));
    const sqlite = tempDb();
    let release!: () => void;
    const issued = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const control = createRunnerControl({
      store: db,
      certificateRoot: "unused",
      disconnect() {},
      now: () => NOW,
      authority: {
        certificate: "authority",
        fingerprint: "authority",
        async issue(csr) {
          if (++requests === 2) release();
          await issued;
          return certificate(csr, 1);
        },
      },
    });
    try {
      const peer = { fingerprint: "first", serial: "serial-first", notAfter: NOW + 100 };
      const results = await Promise.allSettled([
        control.renew(peer, "successor-a"),
        control.renew(peer, "successor-b"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.reason.message).toBe("Runner certificate has been superseded.");
      const successors = await db.run(function* (q) {
        return yield* q.all(q.orm.select().from(q.t.runnerCertificate));
      });
      expect(successors).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  test("a certificate identifies its runner until it is renewed, expired or its owner leaves", async () => {
    const db = await open();
    await db.run((q) => insertRunnerSteps(q, "box"));
    await db.transaction(insertEnrollmentSteps);
    await db.transaction((q) => enrollSteps(q));
    const acceptedUntil = (fingerprint: string) =>
      db.run(function* (q) {
        const { runnerCertificate } = q.t;
        const row = yield* q.one(
          q.orm
            .select({ acceptedUntil: runnerCertificate.acceptedUntil })
            .from(runnerCertificate)
            .where(eq(runnerCertificate.fingerprint, fingerprint)),
        );
        return row!.acceptedUntil;
      });
    const renew = (previousFingerprint: string, fingerprint: string, notBefore: number) =>
      db.transaction((q) =>
        renewRunnerCertificateSteps(q, {
          previousFingerprint,
          certificate: certificate(fingerprint, notBefore, NOW + 10),
          now: NOW,
        }),
      );

    expect((await db.run((q) => runnerForCertificateSteps(q, "first", NOW)))!.id).toBe("paired");
    expect(await db.run((q) => runnerForCertificateSteps(q, "gone", NOW))).toBeNull();
    expect(await db.run((q) => isCurrentRunnerCertificateSteps(q, "first"))).toBe(true);
    expect(await db.run((q) => isCurrentRunnerCertificateSteps(q, "gone"))).toBe(false);

    expect((await renew("first", "second", 1)).id).toBe("paired");
    expect(await acceptedUntil("first")).toBe(NOW + 5 * 60_000);
    expect(await db.run((q) => isCurrentRunnerCertificateSteps(q, "first"))).toBe(false);
    expect(await db.run((q) => isCurrentRunnerCertificateSteps(q, "second"))).toBe(true);
    await expect(renew("first", "third", 2)).rejects.toThrow(
      "Runner certificate has been superseded.",
    );
    await renew("second", "fourth", 3);
    expect(await acceptedUntil("second")).toBe(NOW + 10);
    expect(await db.run((q) => runnerForCertificateSteps(q, "fourth", NOW + 10))).toBeNull();
    await expect(renew("gone", "fifth", 4)).rejects.toThrow(
      "Runner identity is revoked or expired.",
    );

    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.workspaceMember).set({ revokedAt: NOW }));
    });
    expect(await db.run((q) => runnerForCertificateSteps(q, "fourth", NOW))).toBeNull();
  });

  test("revoking a runner ends its authority and returns its certificates", async () => {
    const db = await open();
    const update = (status: "draining" | "revoked") =>
      db.transaction((q) =>
        updateRunnerStatusSteps(q, {
          runnerId: "box",
          workspaceId: "acme",
          userId: "owner",
          status,
          now: NOW,
        }),
      );
    await db.run(function* (q) {
      yield* insertRunnerSteps(q, "box");
      yield* q.exec(
        q.orm.insert(q.t.runnerCertificate).values({
          ...certificate("first"),
          runnerId: "box",
          acceptedUntil: 1_000_000_000,
        }),
      );
      yield* insertWorkSteps(q, "run-1");
      yield* q.exec(
        q.orm.insert(q.t.memberVm).values({
          id: "vm",
          workspaceId: "acme",
          userId: "owner",
          vmName: "vm",
          step: "ready",
          runnerId: "box",
          stepStartedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        }),
      );
    });

    expect(await update("draining")).toEqual([]);
    expect(await db.run((q) => getRunnerSteps(q, "box"))).toMatchObject({
      status: "draining",
      fence: 0,
    });
    expect(await db.run((q) => runnerForCertificateSteps(q, "first", NOW))).not.toBeNull();

    expect(await update("revoked")).toEqual(["first"]);
    expect(await db.run((q) => getRunnerSteps(q, "box"))).toMatchObject({
      status: "revoked",
      fence: 1,
    });
    expect(await db.run((q) => runnerStandingSteps(q, "box"))).toMatchObject({ revokedAt: NOW });
    expect(await db.run((q) => runnerForCertificateSteps(q, "first", NOW))).toBeNull();
    const facts = await db.run(function* (q) {
      const { memberVm, runnerWork } = q.t;
      const vm = yield* q.one(
        q.orm.select({ runnerId: memberVm.runnerId, updatedAt: memberVm.updatedAt }).from(memberVm),
      );
      const work = yield* q.one(
        q.orm.select({ leaseUntil: runnerWork.leaseUntil }).from(runnerWork),
      );
      return { vm, leaseUntil: work!.leaseUntil };
    });
    expect(facts.vm).toEqual({ runnerId: null, updatedAt: NOW });
    expect(facts.leaseUntil).toBeLessThanOrEqual(NOW);
    expect(await auditActions(db)).toEqual(["runner.draining", "runner.revoked"]);
    await expect(update("revoked")).rejects.toThrow("Runner is unavailable.");
  });
});
