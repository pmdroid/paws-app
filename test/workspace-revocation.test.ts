import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeWorkspaceRevocation,
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
import { issueWorkspaceSession, requestWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { createExecutionControlsFixture } from "./local/execution-controls";

async function fixtureTest(
  run: (f: ReturnType<typeof createExecutionControlsFixture>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-member-revocation-"));
  const f = createExecutionControlsFixture(root);
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
