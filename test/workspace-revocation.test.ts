import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeWorkspaceRevocation,
  beginImplementRun,
  insertQueuedItem,
  recordLinearInstallation,
  delegatedLinearUserId,
  recordItemPullRequest,
  getWorkItem,
  listOutbox,
  recordItemBranchState,
  syncWorkspaceMember,
  workspaceMember,
  workspaceMemberUsable,
  listUserWorkspaces,
  WORKSPACE_REVOKED_RESPONSE,
  WORKSPACE_REVOKED_SIGN_IN,
  type Db,
} from "../src/db";
import {
  createWorkspaceAccess,
  issueWorkspaceSession,
  requestWorkspaceSession,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { seed } from "./dialects";
import { createExecutionControlsFixturePg } from "./local/execution-controls";

async function fixtureTest(
  run: (f: Awaited<ReturnType<typeof createExecutionControlsFixturePg>>) => Promise<void>,
  options: Parameters<typeof createExecutionControlsFixturePg>[1] = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-member-revocation-"));
  const f = await createExecutionControlsFixturePg(root, options);
  try {
    await run(f);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function setCreator(db: Db, sessionId: string, creatorId: string | null) {
  return db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.linearSession)
        .set({ creatorId })
        .where(eq(q.t.linearSession.sessionId, sessionId)),
    ),
  );
}

function updateItem(
  db: Db,
  id: string,
  values: {
    state?: string;
    ownerUserId?: string | null;
    delegatedBy?: string | null;
    sessionKey?: string | null;
  },
) {
  return db.run((q) =>
    q.exec(q.orm.update(q.t.workItem).set(values).where(eq(q.t.workItem.id, id))),
  );
}

function insertRunner(db: Db, id: string, name: string, now: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runner).values({
      id,
      workspaceId: "workspace",
      ownerUserId: "member",
      name,
      status: "active",
      createdAt: now,
    }),
  );
}

function runnerRow(db: Db, id: string) {
  return db.run((q) =>
    q.one(
      q.orm
        .select({ status: q.t.runner.status, fence: q.t.runner.fence })
        .from(q.t.runner)
        .where(eq(q.t.runner.id, id)),
    ),
  );
}

function certificateRevokedAt(db: Db) {
  return db.run(function* (q) {
    const row = yield* q.one(
      q.orm
        .select({ revokedAt: q.t.runnerCertificate.revokedAt })
        .from(q.t.runnerCertificate)
        .where(eq(q.t.runnerCertificate.fingerprint, "cert")),
    );
    return row?.revokedAt;
  });
}

function memberSession(db: Db) {
  return db.run((q) =>
    q.one(
      q.orm
        .select({ userId: q.t.workspaceSession.userId })
        .from(q.t.workspaceSession)
        .where(eq(q.t.workspaceSession.userId, "member")),
    ),
  );
}

function revocationAudit(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          userId: q.t.workspaceAccessAudit.userId,
          subject: q.t.workspaceAccessAudit.subject,
        })
        .from(q.t.workspaceAccessAudit)
        .where(eq(q.t.workspaceAccessAudit.action, "workspace.member_revoked")),
    ),
  );
}

test("admin revoke atomically ends sessions, runners, queued and running work; sync cannot restore access", async () => {
  await fixtureTest(async (f) => {
    const { db } = f;
    const now = Date.now();
    await setCreator(db, "session-unmapped", "member");
    await recordItemBranchState(db, {
      itemId: "controlled",
      runId: f.runId,
      head: "head",
      base: "base",
      commits: 2,
      recordedAt: now,
    });
    await setCreator(db, "session-controlled", "member");
    await insertRunner(db, "box", "Box", now);
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCertificate).values({
        fingerprint: "cert",
        runnerId: "box",
        serial: "serial",
        pem: "pem",
        notBefore: now,
        notAfter: now + 100_000,
        acceptedUntil: now + 100_000,
      }),
    );
    const members = async () =>
      (
        (await (
          await fetch(`${f.origin}/api/workspaces/members`, { headers: f.headers("admin") })
        ).json()) as { members: Record<string, unknown>[] }
      ).members.find((entry) => entry["id"] === "member")!;
    expect(await members()).toMatchObject({
      role: "member",
      revokedAt: null,
      revokedByName: null,
      runners: 1,
      openItems: 3,
    });
    const response = await fetch(`${f.origin}/api/workspaces/members`, {
      method: "PUT",
      headers: f.headers("admin"),
      body: JSON.stringify({ userId: "member", revoked: true }),
    });
    expect(response.status).toBe(200);
    expect(await members()).toMatchObject({
      revokedBy: "admin",
      revokedByName: expect.any(String),
      runners: 0,
      openItems: 0,
    });
    const member = (await workspaceMember(db, "workspace", "member"))!;
    expect(member.active).toBe(true);
    expect(member.revokedAt).not.toBeNull();
    expect(member.revokedBy).toBe("admin");
    expect(await memberSession(db)).toBeUndefined();
    expect(await runnerRow(db, "box")).toEqual({ status: "revoked", fence: 1 });
    expect(await certificateRevokedAt(db)).toBe(member.revokedAt!);
    for (const id of ["controlled", "other", "unmapped"])
      expect((await getWorkItem(db, id))?.state).toBe("cancelled");
    expect((await getWorkItem(db, "foreign"))?.state).toBe("queued");
    const responses = (await listOutbox(db))
      .map((row) => row.payload as { body?: string; sessionId?: string })
      .filter((payload) => payload.body === WORKSPACE_REVOKED_RESPONSE);
    expect(new Set(responses.map((payload) => payload.sessionId))).toEqual(
      new Set(["session-controlled", "session-unmapped"]),
    );
    expect(await revocationAudit(db)).toEqual([{ userId: "admin", subject: "member" }]);
    await syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds: ["team"],
      now: now + 1,
    });
    expect(workspaceMemberUsable(await workspaceMember(db, "workspace", "member"))).toBe(false);
    expect(await listUserWorkspaces(db, "member")).toEqual([]);
    await expect(
      issueWorkspaceSession(db, { workspaceId: "workspace", userId: "member", now }),
    ).rejects.toThrow(WORKSPACE_REVOKED_SIGN_IN);
    expect(
      await requestWorkspaceSession(
        db,
        new Request(f.origin, {
          headers: { cookie: `${WORKSPACE_COOKIE}=${f.sessions["member"]!.token}` },
        }),
        now,
      ),
    ).toBeNull();
    const restored = await fetch(`${f.origin}/api/workspaces/members`, {
      method: "PUT",
      headers: f.headers("admin"),
      body: JSON.stringify({ userId: "member", revoked: false }),
    });
    expect(restored.status).toBe(200);
    expect(
      (
        await issueWorkspaceSession(db, {
          workspaceId: "workspace",
          userId: "member",
          now,
        })
      ).token,
    ).toBeTruthy();
    expect(await runnerRow(db, "box")).toEqual({ status: "revoked", fence: 1 });
    expect(await certificateRevokedAt(db)).toBe(member.revokedAt);
  });
});

test("revoke and restore require admin, origin and CSRF; self and last admin stay protected", async () => {
  await fixtureTest(async (f) => {
    for (const revoked of [true, false]) {
      const send = (user: string, extra = {}) =>
        fetch(`${f.origin}/api/workspaces/members`, {
          method: "PUT",
          headers: { ...f.headers(user), ...extra },
          body: JSON.stringify({ userId: "outside", revoked }),
        });
      expect((await send("member")).status).toBe(403);
      expect((await send("admin", { origin: "https://elsewhere.invalid" })).status).toBe(403);
      expect((await send("admin", { "x-paws-csrf": "wrong" })).status).toBe(403);
    }
    const invalid = await fetch(`${f.origin}/api/workspaces/members`, {
      method: "PUT",
      headers: f.headers("admin"),
      body: JSON.stringify({ userId: "outside", revoked: "true" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Choose a workspace member and set revoked to true or false.",
    });
    await expect(
      changeWorkspaceRevocation(f.db, {
        workspaceId: "workspace",
        actorId: "admin",
        userId: "admin",
        revoked: true,
        now: Date.now(),
      }),
    ).rejects.toThrow("You cannot revoke your own access.");
    expect(workspaceMemberUsable(await workspaceMember(f.db, "workspace", "admin"))).toBe(true);
    await expect(
      changeWorkspaceRevocation(f.db, {
        workspaceId: "workspace",
        actorId: "member",
        userId: "admin",
        revoked: true,
        now: Date.now(),
      }),
    ).rejects.toThrow("Workspace administration is required.");
  });
});

test("a failed Stop rolls back the whole revocation", async () => {
  await fixtureTest(async (f) => {
    await setCreator(f.db, "session-controlled", "member");
    await seed(
      f.db,
      (q) =>
        q.orm.execute(
          sql`CREATE FUNCTION fail_stop() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture Stop failure'; END $$ LANGUAGE plpgsql`,
        ),
      (q) =>
        q.orm.execute(
          sql`CREATE TRIGGER fail_stop BEFORE UPDATE ON work_item FOR EACH ROW EXECUTE FUNCTION fail_stop()`,
        ),
    );
    await expect(
      changeWorkspaceRevocation(f.db, {
        workspaceId: "workspace",
        actorId: "admin",
        userId: "member",
        revoked: true,
        now: Date.now(),
      }),
    ).rejects.toThrow("Work changed before access could be revoked.");
    expect((await workspaceMember(f.db, "workspace", "member"))?.revokedAt).toBeNull();
    expect(await memberSession(f.db)).toBeDefined();
    expect(await revocationAudit(f.db)).toEqual([]);
    expect((await getWorkItem(f.db, "controlled"))?.state).toBe("running");
  });
});

test("revocation uses resolved delegator ownership, not the session creator", async () => {
  await fixtureTest(async ({ db }) => {
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workspaceUser)
          .set({ linearUserId: "linear-member" })
          .where(eq(q.t.workspaceUser.id, "member")),
      ),
    );
    const now = Date.now();
    const cases = [
      ["owner", "member", "outside", "app", true],
      ["delegated", null, "linear-member", "app", true],
      ["creator", null, null, "linear-member", true],
      ["other-owner", "outside", "linear-member", "linear-member", false],
      ["other-delegator", null, "outside", "linear-member", false],
      ["other-organization", "member", null, "linear-member", false],
    ] as const;
    for (const [id, owner, delegated, creator] of cases) {
      await insertQueuedItem(db, { id, sessionKey: `ownership-${id}`, now });
      await recordLinearInstallation(db, {
        sessionId: `ownership-${id}`,
        organizationId: id === "other-organization" ? "foreign" : "org",
        teamId: "team",
        oauthClientId: "client",
        appUserId: "app",
        observedAtMs: now,
      });
      await setCreator(db, `ownership-${id}`, creator);
      await updateItem(db, id, { ownerUserId: owner, delegatedBy: delegated });
    }
    const stopped = await changeWorkspaceRevocation(db, {
      workspaceId: "workspace",
      actorId: "admin",
      userId: "member",
      revoked: true,
      now,
    });
    expect(new Set(stopped)).toEqual(new Set(["owner", "delegated", "creator"]));
    for (const [id, , , , stop] of cases) {
      expect((await getWorkItem(db, id))?.state).toBe(stop ? "cancelled" : "queued");
      if (stop) expect(await delegatedLinearUserId(db, id)).toBe("linear-member");
    }
    const responses = (await listOutbox(db))
      .map((row) => row.payload as { body?: string; sessionId?: string })
      .filter((p) => p.body === WORKSPACE_REVOKED_RESPONSE);
    expect(new Set(responses.map((p) => p.sessionId))).toEqual(
      new Set(["ownership-owner", "ownership-delegated", "ownership-creator"]),
    );
  });
});

test("revocation stops accepted work without closing its pull request", async () => {
  await fixtureTest(async ({ db }) => {
    await setCreator(db, "session-controlled", "member");
    await updateItem(db, "controlled", { state: "merge_queue" });
    await recordItemPullRequest(db, {
      itemId: "controlled",
      pullNumber: 87,
      pullUrl: "https://example.invalid/pull/87",
      openedAt: Date.now(),
    });
    await changeWorkspaceRevocation(db, {
      workspaceId: "workspace",
      actorId: "admin",
      userId: "member",
      revoked: true,
      now: Date.now(),
    });
    expect((await getWorkItem(db, "controlled"))?.state).toBe("cancelled");
    expect(
      await db.run((q) =>
        q.one(
          q.orm
            .select({ id: q.t.job.id })
            .from(q.t.job)
            .where(eq(q.t.job.queue, JOB_KIND.closeStoppedPull)),
        ),
      ),
    ).toBeUndefined();
    expect(
      await db.run((q) =>
        q.one(
          q.orm
            .select({ pullNumber: q.t.itemPullRequest.pullNumber })
            .from(q.t.itemPullRequest)
            .where(eq(q.t.itemPullRequest.itemId, "controlled")),
        ),
      ),
    ).toEqual({ pullNumber: 87 });
    expect(
      (await listOutbox(db)).some(
        (row) => (row.payload as { body?: string }).body === WORKSPACE_REVOKED_RESPONSE,
      ),
    ).toBe(true);
  });
});

test("revoke returns after durable Stop while all interrupts are still pending", async () => {
  const gate = Promise.withResolvers<void>();
  const called: string[] = [];
  try {
    await fixtureTest(
      async (f) => {
        await setCreator(f.db, "session-controlled", "member");
        const pending = fetch(`${f.origin}/api/workspaces/members`, {
          method: "PUT",
          headers: f.headers("admin"),
          body: JSON.stringify({ userId: "member", revoked: true }),
        });
        const response = await Promise.race([pending, Bun.sleep(2000).then(() => null)]);
        expect(response?.status).toBe(200);
        expect(new Set(called)).toEqual(new Set(["controlled", "other"]));
        expect((await getWorkItem(f.db, "controlled"))?.state).toBe("cancelled");
      },
      {
        interruptItem: async (id) => {
          called.push(id);
          await gate.promise;
        },
      },
    );
  } finally {
    gate.resolve();
  }
});

test("a forced attribution refresh corrects an inactive snapshot after joining an earlier read", async () => {
  await fixtureTest(async (f) => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let reads = 0;
    let at = Date.now() + 100;
    let calls = 0;
    let inFlight = 0;
    const track = <T>(work: Promise<T>) => {
      calls++;
      inFlight++;
      return work.finally(() => inFlight--);
    };
    const store = {
      ...f.db,
      run: (body) => track(f.db.run(body)),
      transaction: (body) => track(f.db.transaction(body)),
    } as Db;
    const access = createWorkspaceAccess({
      store,
      publicUrl: f.origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Workspace" },
      now: () => ++at,
      memberships: {
        async installation() {
          return { id: "org", name: "Workspace" };
        },
        async member(organizationId, userId) {
          const n = userId === "member" ? ++reads : 0;
          if (n === 1) {
            started.resolve();
            await gate.promise;
          }
          return {
            organizationId,
            userId,
            active: n !== 1,
            guest: false,
            admin: false,
            teamIds: ["team"],
          };
        },
      },
    });
    try {
      const refresh = access.refreshMemberships();
      await started.promise;
      const before = calls;
      const attribution = access.handle(
        new Request(`${f.origin}/api/workspaces/github-attribution`, {
          headers: f.headers("member"),
        }),
      );
      for (let idle = 0; idle < 5; idle = calls > before && inFlight === 0 ? idle + 1 : 0)
        await Bun.sleep(1);
      gate.resolve();
      await refresh;
      await attribution;
      expect(reads).toBe(2);
      expect((await workspaceMember(f.db, "workspace", "member"))?.active).toBe(true);
    } finally {
      gate.resolve();
      await access.stop();
    }
  });
});

test("revocation stops explicit owners and delegators without session metadata", async () => {
  await fixtureTest(async ({ db }) => {
    const nullIdentity = (await db
      .run((q) =>
        q.exec(
          q.orm
            .update(q.t.workspaceUser)
            .set({ linearUserId: sql`NULL` })
            .where(eq(q.t.workspaceUser.id, "member")),
        ),
      )
      .catch((error: unknown) => error)) as Error;
    expect(String(nullIdentity.cause)).toContain("not-null");
    const cases = [
      ["owner-no-session", "member", "outside", null, true, true],
      ["owner-missing-session", "member", null, "missing-owner", true, false],
      ["delegator-no-session", null, "member", null, true, false],
      ["delegator-missing-session", null, "member", "missing-delegator", true, true],
      ["other-owner-no-session", "outside", "member", null, false, false],
      ["unowned-no-session", null, null, null, false, false],
      ["other-org-owner", "member", null, "foreign-owned", false, false],
    ] as const;
    const now = Date.now();
    for (const [id, owner, delegator, session, , running] of cases) {
      await insertQueuedItem(db, { id, now });
      await updateItem(db, id, { ownerUserId: owner, delegatedBy: delegator, sessionKey: session });
      if (session === "foreign-owned")
        await recordLinearInstallation(db, {
          sessionId: session,
          organizationId: "foreign",
          teamId: "team",
          oauthClientId: "client",
          appUserId: "app",
          observedAtMs: now,
        });
      if (running) await beginImplementRun(db, id, now);
    }
    const stopped = await changeWorkspaceRevocation(db, {
      workspaceId: "workspace",
      actorId: "admin",
      userId: "member",
      revoked: true,
      now,
    });
    const expected = cases.filter((c) => c[4]);
    expect(new Set(stopped)).toEqual(new Set(expected.map((c) => c[0])));
    for (const [id, , , , stop] of cases)
      expect((await getWorkItem(db, id))?.state).toBe(stop ? "cancelled" : "queued");
    const responses = (await listOutbox(db))
      .map((row) => row.payload as { body?: string; sessionId?: string })
      .filter((row) => row.body === WORKSPACE_REVOKED_RESPONSE);
    expect(new Set(responses.map((row) => row.sessionId))).toEqual(
      new Set(expected.map((c) => c[3] ?? c[0])),
    );
  });
});

test("revoking an idle member detaches their VM runner and notifies the connection owner after commit", async () => {
  let calls = 0;
  let committed = false;
  let database!: Db;
  await fixtureTest(
    async (f) => {
      database = f.db;
      const now = Date.now();
      await insertRunner(f.db, "idle-box", "Idle", now);
      await seed(f.db, (q) =>
        q.orm.insert(q.t.memberVm).values({
          id: "vm",
          workspaceId: "workspace",
          userId: "member",
          vmName: "vm-idle",
          step: "ready",
          runnerId: "idle-box",
          stepStartedAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const response = await fetch(`${f.origin}/api/workspaces/members`, {
        method: "PUT",
        headers: f.headers("admin"),
        body: JSON.stringify({ userId: "member", revoked: true }),
      });
      expect(response.status).toBe(200);
      expect(calls).toBe(1);
      expect(committed).toBe(true);
      expect(
        await f.db.run((q) =>
          q.one(
            q.orm
              .select({ runnerId: q.t.memberVm.runnerId })
              .from(q.t.memberVm)
              .where(eq(q.t.memberVm.id, "vm")),
          ),
        ),
      ).toEqual({ runnerId: null });
      expect((await runnerRow(f.db, "idle-box"))?.status).toBe("revoked");
      const restore = await fetch(`${f.origin}/api/workspaces/members`, {
        method: "PUT",
        headers: f.headers("admin"),
        body: JSON.stringify({ userId: "member", revoked: false }),
      });
      expect(restore.status).toBe(200);
      expect(calls).toBe(1);
    },
    {
      onMemberRevoked: async () => {
        calls++;
        committed = (await workspaceMember(database, "workspace", "member"))?.revokedAt != null;
      },
    },
  );
});
