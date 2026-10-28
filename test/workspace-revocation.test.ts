import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeWorkspaceRevocation,
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
} from "../src/db";
import {
  createWorkspaceAccess,
  issueWorkspaceSession,
  requestWorkspaceSession,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { createExecutionControlsFixture } from "./local/execution-controls";

async function fixtureTest(
  run: (f: ReturnType<typeof createExecutionControlsFixture>) => Promise<void>,
  options: Parameters<typeof createExecutionControlsFixture>[1] = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-member-revocation-"));
  const f = createExecutionControlsFixture(root, options);
  try {
    await run(f);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("admin revoke atomically ends sessions, runners, queued and running work; sync cannot restore access", async () => {
  await fixtureTest(async (f) => {
    const { db } = f;
    const now = Date.now();
    db.run("UPDATE linear_session SET creator_id='member' WHERE session_id='session-unmapped'");
    recordItemBranchState(db, {
      itemId: "controlled",
      runId: f.runId,
      head: "head",
      base: "base",
      commits: 2,
      recordedAt: now,
    });
    db.run("UPDATE linear_session SET creator_id='member' WHERE session_id='session-controlled'");
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('box','workspace','member','Box','active',?)",
      [now],
    );
    db.run(
      "INSERT INTO runner_certificate(fingerprint,runner_id,serial,pem,not_before,not_after,accepted_until) VALUES('cert','box','serial','pem',?,?,?)",
      [now, now + 100_000, now + 100_000],
    );
    const response = await fetch(`${f.origin}/api/workspaces/members`, {
      method: "PUT",
      headers: f.headers("admin"),
      body: JSON.stringify({ userId: "member", revoked: true }),
    });
    expect(response.status).toBe(200);
    const member = workspaceMember(db, "workspace", "member")!;
    expect(member.active).toBe(true);
    expect(member.revokedAt).not.toBeNull();
    expect(member.revokedBy).toBe("admin");
    expect(db.query("SELECT 1 FROM workspace_session WHERE user_id='member'").get()).toBeNull();
    expect(db.query("SELECT status,fence FROM runner WHERE id='box'").get()).toEqual({
      status: "revoked",
      fence: 1,
    });
    expect(
      db
        .query<{ revoked_at: number }, []>(
          "SELECT revoked_at FROM runner_certificate WHERE fingerprint='cert'",
        )
        .get()!.revoked_at,
    ).toBe(member.revokedAt!);
    for (const id of ["controlled", "other", "unmapped"])
      expect(getWorkItem(db, id)?.state).toBe("cancelled");
    expect(getWorkItem(db, "foreign")?.state).toBe("queued");
    const responses = listOutbox(db)
      .map((row) => row.payload as { body?: string; sessionId?: string })
      .filter((payload) => payload.body === WORKSPACE_REVOKED_RESPONSE);
    expect(new Set(responses.map((payload) => payload.sessionId))).toEqual(
      new Set(["session-controlled", "session-unmapped"]),
    );
    expect(
      db
        .query(
          "SELECT user_id,subject FROM workspace_access_audit WHERE action='workspace.member_revoked'",
        )
        .all(),
    ).toEqual([{ user_id: "admin", subject: "member" }]);
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds: ["team"],
      now: now + 1,
    });
    expect(workspaceMemberUsable(workspaceMember(db, "workspace", "member"))).toBe(false);
    expect(listUserWorkspaces(db, "member")).toEqual([]);
    expect(() =>
      issueWorkspaceSession(db, { workspaceId: "workspace", userId: "member", now }),
    ).toThrow(WORKSPACE_REVOKED_SIGN_IN);
    expect(
      requestWorkspaceSession(
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
      issueWorkspaceSession(db, { workspaceId: "workspace", userId: "member", now }).token,
    ).toBeTruthy();
    expect(db.query("SELECT status,fence FROM runner WHERE id='box'").get()).toEqual({
      status: "revoked",
      fence: 1,
    });
    expect(
      db.query("SELECT revoked_at FROM runner_certificate WHERE fingerprint='cert'").get(),
    ).toEqual({ revoked_at: member.revokedAt });
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
    expect(() =>
      changeWorkspaceRevocation(f.db, {
        workspaceId: "workspace",
        actorId: "admin",
        userId: "admin",
        revoked: true,
        now: Date.now(),
      }),
    ).toThrow("You cannot revoke your own access.");
    expect(workspaceMemberUsable(workspaceMember(f.db, "workspace", "admin"))).toBe(true);
    expect(() =>
      changeWorkspaceRevocation(f.db, {
        workspaceId: "workspace",
        actorId: "member",
        userId: "admin",
        revoked: true,
        now: Date.now(),
      }),
    ).toThrow("Workspace administration is required.");
  });
});

test("a failed Stop rolls back the whole revocation", async () => {
  await fixtureTest(async (f) => {
    f.db.run("UPDATE linear_session SET creator_id='member' WHERE session_id='session-controlled'");
    f.db.run(
      "CREATE TRIGGER fail_stop BEFORE UPDATE ON work_item BEGIN SELECT RAISE(ABORT,'fixture Stop failure'); END",
    );
    expect(() =>
      changeWorkspaceRevocation(f.db, {
        workspaceId: "workspace",
        actorId: "admin",
        userId: "member",
        revoked: true,
        now: Date.now(),
      }),
    ).toThrow("Work changed before access could be revoked.");
    expect(workspaceMember(f.db, "workspace", "member")?.revokedAt).toBeNull();
    expect(
      f.db.query("SELECT 1 FROM workspace_session WHERE user_id='member'").get(),
    ).not.toBeNull();
    expect(
      f.db
        .query("SELECT 1 FROM workspace_access_audit WHERE action='workspace.member_revoked'")
        .get(),
    ).toBeNull();
    expect(getWorkItem(f.db, "controlled")?.state).toBe("running");
  });
});

test("revocation uses resolved delegator ownership, not the session creator", async () => {
  await fixtureTest(async ({ db }) => {
    db.run("UPDATE workspace_user SET linear_user_id='linear-member' WHERE id='member'");
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
      insertQueuedItem(db, { id, sessionKey: `ownership-${id}`, now });
      recordLinearInstallation(db, {
        sessionId: `ownership-${id}`,
        organizationId: id === "other-organization" ? "foreign" : "org",
        teamId: "team",
        oauthClientId: "client",
        appUserId: "app",
        observedAtMs: now,
      });
      db.run("UPDATE linear_session SET creator_id=? WHERE session_id=?", [
        creator,
        `ownership-${id}`,
      ]);
      db.run("UPDATE work_item SET owner_user_id=?,delegated_by=? WHERE id=?", [
        owner,
        delegated,
        id,
      ]);
    }
    const stopped = changeWorkspaceRevocation(db, {
      workspaceId: "workspace",
      actorId: "admin",
      userId: "member",
      revoked: true,
      now,
    });
    expect(new Set(stopped)).toEqual(new Set(["owner", "delegated", "creator"]));
    for (const [id, , , , stop] of cases) {
      expect(getWorkItem(db, id)?.state).toBe(stop ? "cancelled" : "queued");
      if (stop) expect(delegatedLinearUserId(db, id)).toBe("linear-member");
    }
    const responses = listOutbox(db)
      .map((row) => row.payload as { body?: string; sessionId?: string })
      .filter((p) => p.body === WORKSPACE_REVOKED_RESPONSE);
    expect(new Set(responses.map((p) => p.sessionId))).toEqual(
      new Set(["ownership-owner", "ownership-delegated", "ownership-creator"]),
    );
  });
});

test("revocation stops accepted work without closing its pull request", async () => {
  await fixtureTest(async ({ db }) => {
    db.run("UPDATE linear_session SET creator_id='member' WHERE session_id='session-controlled'");
    db.run("UPDATE work_item SET state='merge_queue' WHERE id='controlled'");
    recordItemPullRequest(db, {
      itemId: "controlled",
      pullNumber: 87,
      pullUrl: "https://example.invalid/pull/87",
      openedAt: Date.now(),
    });
    changeWorkspaceRevocation(db, {
      workspaceId: "workspace",
      actorId: "admin",
      userId: "member",
      revoked: true,
      now: Date.now(),
    });
    expect(getWorkItem(db, "controlled")?.state).toBe("cancelled");
    expect(db.query("SELECT 1 FROM job WHERE queue=?").get(JOB_KIND.closeStoppedPull)).toBeNull();
    expect(
      db.query("SELECT pull_number FROM item_pull_request WHERE item_id='controlled'").get(),
    ).toEqual({ pull_number: 87 });
    expect(
      listOutbox(db).some(
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
        f.db.run(
          "UPDATE linear_session SET creator_id='member' WHERE session_id='session-controlled'",
        );
        const pending = fetch(`${f.origin}/api/workspaces/members`, {
          method: "PUT",
          headers: f.headers("admin"),
          body: JSON.stringify({ userId: "member", revoked: true }),
        });
        const response = await Promise.race([pending, Bun.sleep(2000).then(() => null)]);
        expect(response?.status).toBe(200);
        expect(new Set(called)).toEqual(new Set(["controlled", "other"]));
        expect(getWorkItem(f.db, "controlled")?.state).toBe("cancelled");
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
    const access = createWorkspaceAccess({
      db: f.db,
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
      const attribution = access.handle(
        new Request(`${f.origin}/api/workspaces/github-attribution`, {
          headers: f.headers("member"),
        }),
      );
      gate.resolve();
      await refresh;
      await attribution;
      expect(reads).toBe(2);
      expect(workspaceMember(f.db, "workspace", "member")?.active).toBe(true);
    } finally {
      gate.resolve();
      await access.stop();
    }
  });
});
