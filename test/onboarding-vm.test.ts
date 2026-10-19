import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import {
  createWorkspaceAccess,
  createWorkspaceAssignments,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";

test("assignment VM selection is durable, member-owned, generation-fenced and independent of GitHub", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-onboarding-vm-"));
  const path = join(root, "paws.sqlite");
  let db = openDatabase(path);
  migrate(db);
  const now = Date.now();
  for (const id of ["owner", "member", "other"])
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const id of ["member", "other"])
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  const installation = {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  };
  const spec = {
    linearIssueId: "issue",
    identifier: "PAS-340",
    title: "Select VM",
    description: "Fixture",
    subIssues: [],
  };
  ensureLinearSession(db, { sessionId: "session", issueId: "issue", creatorId: "member" });
  recordLinearInstallation(db, installation);
  const insertAssignment = (generation: number) =>
    db.run("INSERT INTO workspace_assignment VALUES(?,?,?,?,?,?,?,?,?)", [
      "session",
      generation,
      "workspace",
      "member",
      workspaceTokenHash(String(generation)),
      JSON.stringify({ installation, spec }),
      "{}",
      now + 600000,
      "ready",
    ]);
  insertAssignment(0);
  const sessions = Object.fromEntries(
    ["member", "other", "owner"].map((userId) => [
      userId,
      issueWorkspaceSession(db, { workspaceId: "workspace", userId, now }),
    ]),
  );
  const memberships = {
    async installation() {
      return { id: "org", name: "Workspace" };
    },
    async member(organizationId: string, userId: string) {
      const member = db
        .query<{ role: string; active: number }, [string]>(
          "SELECT role,active FROM workspace_member WHERE workspace_id='workspace' AND user_id=?",
        )
        .get(userId)!;
      return {
        organizationId,
        userId,
        active: member.active === 1,
        guest: member.role === "observer",
        admin: false,
        teamIds: ["team"],
      };
    },
  };
  const buildAssignments = (enabled = true) =>
    createWorkspaceAssignments({
      db,
      ...(enabled ? { onboarding: {} } : {}),
      origin: "https://paws.example.invalid",
      clientId: "client",
      memberships,
      tracker: createFakeTracker([spec]),
      lifecycle: {
        async inspect() {
          throw new Error("No dispatch");
        },
        async startCodeIssue() {
          throw new Error("No credentials");
        },
      },
      async accept() {
        throw new Error("No dispatch");
      },
      async continue() {
        throw new Error("No continuation");
      },
      now: () => now,
    });
  let assignments = buildAssignments();
  let access: ReturnType<typeof createWorkspaceAccess>;
  let authenticatedBody: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      if (authenticatedBody) {
        await access.authenticate(request);
        const beforeBody = authenticatedBody;
        authenticatedBody = undefined;
        beforeBody();
      }
      return (await access.handle(request)) ?? new Response(null, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const buildAccess = () =>
    createWorkspaceAccess({
      db,
      assignments,
      publicUrl: origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Workspace" },
      memberships,
      now: () => now,
    });
  access = buildAccess();
  const headers = (user = "member") => ({
    cookie: `${WORKSPACE_COOKIE}=${sessions[user]!.token}`,
    origin,
    "x-paws-csrf": sessions[user]!.session.csrfToken,
    "content-type": "application/json",
  });
  const state = async (generation = 0) =>
    (
      await fetch(`${origin}/api/workspaces/onboarding?session=session&generation=${generation}`, {
        headers: headers(),
      })
    ).json() as Promise<{
      github: { state: string };
      vm: { state: string; selectedRunner: { id: string } | null; runners: { id: string }[] };
    }>;
  const select = (runnerId: string, user = "member", extra = {}, generation = 0, override = {}) =>
    fetch(`${origin}/api/workspaces/onboarding/vm`, {
      method: "POST",
      headers: { ...headers(user), ...override },
      body: JSON.stringify({ session: "session", generation, runnerId, ...extra }),
    });
  const addRunner = (owner = "member", status = "active", valid = true) => {
    const id = workspaceId();
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,?,?)",
      [id, "workspace", owner, id, status, now],
    );
    db.run(
      "INSERT INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until) VALUES(?,?,?,?,?,?,?)",
      [id, id, id, "synthetic certificate", now - 1, now + 600000, valid ? now + 600000 : now],
    );
    return id;
  };
  try {
    expect(
      (
        await fetch(`${origin}/api/workspaces/onboarding/vm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    assignments = buildAssignments(false);
    access = buildAccess();
    expect((await select(workspaceId())).status).toBe(404);
    assignments = buildAssignments();
    access = buildAccess();
    expect((await state()).vm.state).toBe("not_linked");
    const foreign = addRunner("other");
    addRunner("member", "paused");
    addRunner("member", "draining");
    addRunner("member", "active", false);
    expect((await state()).vm.runners).toEqual([]);
    const unclaimed = addRunner();
    db.run(
      "INSERT INTO runner_pairing(id,claim_hash,code_hash,csr,name,request_fingerprint,expires_at,runner_id) VALUES(?,?,?,?,?,?,?,?)",
      [
        unclaimed,
        unclaimed,
        unclaimed,
        "synthetic CSR",
        "Unclaimed",
        unclaimed,
        now + 600000,
        unclaimed,
      ],
    );
    expect((await state()).vm.runners).toEqual([]);
    const first = addRunner();
    expect((await state()).vm.selectedRunner?.id).toBe(first);
    expect(db.query("SELECT count(*) AS count FROM onboarding_vm").get()).toEqual({ count: 0 });
    const second = addRunner();
    expect((await state()).vm.state).toBe("choice_required");
    expect((await select(foreign)).status).toBe(409);
    expect((await select(first, "other")).status).toBe(404);
    expect((await select(first, "owner")).status).toBe(404);
    expect((await select(first, "member", { userId: "other" })).status).toBe(400);
    expect((await select(first, "member", {}, 0, { "x-paws-csrf": "wrong" })).status).toBe(403);
    expect(
      (await select(first, "member", {}, 0, { origin: "https://foreign.invalid" })).status,
    ).toBe(403);
    expect((await select(first, "member", {}, 0, { "x-paws-workspace": "foreign" })).status).toBe(
      403,
    );
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('foreign-workspace','foreign-org','Foreign',?)",
      [now],
    );
    syncWorkspaceMember(db, {
      workspaceId: "foreign-workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
    db.run("UPDATE runner SET workspace_id='foreign-workspace' WHERE id=?", [first]);
    expect((await select(first)).status).toBe(409);
    db.run("UPDATE runner SET workspace_id='workspace' WHERE id=?", [first]);
    expect((await select(first)).status).toBe(200);
    expect((await select(first)).status).toBe(200);
    expect(
      db
        .query(
          "SELECT count(*) AS count FROM workspace_access_audit WHERE action='assignment.vm_selected'",
        )
        .get(),
    ).toEqual({ count: 1 });
    db.close();
    db = openDatabase(path);
    assignments = buildAssignments();
    access = buildAccess();
    expect((await state()).vm.selectedRunner?.id).toBe(first);
    expect((await state()).github.state).toBe("not_checked");
    expect(assignments.authorizeIntake("session", spec)).toBe(false);
    db.run("UPDATE runner SET fence=fence+1 WHERE id=?", [first]);
    expect((await state()).vm.selectedRunner).toBeNull();
    expect((await select(first)).status).toBe(200);
    db.run("UPDATE runner_certificate SET accepted_until=? WHERE runner_id=?", [now, first]);
    expect((await state()).vm.selectedRunner).toBeNull();
    db.run("UPDATE runner_certificate SET accepted_until=? WHERE runner_id=?", [
      now + 600000,
      first,
    ]);
    authenticatedBody = () => db.run("DELETE FROM workspace_user_team WHERE user_id='member'");
    expect((await select(second)).status).toBe(404);
    db.run("INSERT INTO workspace_user_team VALUES('workspace','member','team')");
    expect((await state()).vm.selectedRunner?.id).toBe(first);
    db.run("UPDATE runner SET status='revoked',revoked_at=?,fence=fence+1 WHERE id=?", [
      now,
      first,
    ]);
    expect((await state()).vm.state).toBe("choice_required");
    expect((await state()).vm.selectedRunner).toBeNull();
    expect((await select(first)).status).toBe(409);
    expect((await select(second)).status).toBe(200);
    advanceLinearSessionGeneration(db, "session", { now });
    expect((await select(second)).status).toBe(404);
    insertAssignment(1);
    expect((await state(1)).vm.selectedRunner?.id).toBe(second);
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "observer",
      active: true,
      teamIds: ["team"],
      now: now + 1,
    });
    expect((await select(second, "member", {}, 1)).status).toBe(404);
    for (const table of ["runner_command", "runner_work_grant", "work_item", "job"])
      expect(db.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  } finally {
    await server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
