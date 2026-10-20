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

test("onboarding shows only the member's provisioned healthy VM and offers no runner picker", async () => {
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
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
  const read = (generation = 0, user = "member") =>
    fetch(`${origin}/api/workspaces/onboarding?session=session&generation=${generation}`, {
      headers: headers(user),
    });
  const state = async (generation = 0) =>
    (await read(generation)).json() as Promise<{
      github: { state: string };
      vm: {
        state: string;
        ready: boolean;
        runner: { id: string } | null;
        machine: { name: string; reused: boolean } | null;
        steps: { name: string; state: string }[];
      };
    }>;
  const select = (runnerId: string) =>
    fetch(`${origin}/api/workspaces/onboarding/vm`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ session: "session", generation: 0, runnerId }),
    });
  const addRunner = (owner = "member") => {
    const id = workspaceId();
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, "workspace", owner, id, now, now],
    );
    db.run(
      "INSERT INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until) VALUES(?,?,?,?,?,?,?)",
      [id, id, id, "synthetic certificate", now - 1, now + 600000, now + 600000],
    );
    return id;
  };
  const provision = (runnerId: string) =>
    db.run(
      "INSERT INTO member_vm(id,workspace_id,user_id,provider_name,step,state,create_outcome,runner_id,origin_session_id,origin_generation,created_at,updated_at) VALUES('vm','workspace','member','paws-member','ready','ready','created',?,'session',0,?,?)",
      [runnerId, now, now],
    );
  try {
    expect(
      (
        await fetch(`${origin}/api/workspaces/onboarding/vm/retry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const paired = addRunner();
    expect((await state()).vm).toMatchObject({ state: "unavailable", runner: null, steps: [] });
    expect((await select(paired)).status).toBe(404);
    expect((await state()).vm.runner).toBeNull();
    expect(db.query("SELECT count(*) AS count FROM onboarding_vm").get()).toEqual({ count: 0 });
    expect(
      db
        .query(
          "SELECT count(*) AS count FROM workspace_access_audit WHERE action LIKE 'assignment.vm%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const first = addRunner();
    provision(first);
    db.close();
    db = openDatabase(path);
    assignments = buildAssignments();
    access = buildAccess();
    expect((await state()).vm).toMatchObject({
      state: "ready",
      ready: true,
      runner: { id: first },
      machine: { name: "paws-member", reused: false },
    });
    expect((await state()).github.state).toBe("not_checked");
    expect(assignments.authorizeIntake("session", spec)).toBe(false);
    expect((await read(0, "other")).status).toBe(404);
    expect((await read(0, "owner")).status).toBe(404);
    const withdrawn = async () => {
      const vm = (await state()).vm;
      expect(vm).toMatchObject({ ready: false, runner: null });
      expect(vm.steps.map((entry) => `${entry.name}:${entry.state}`)).toEqual([
        "create:done",
        "install:done",
        "pair:done",
        "health:running",
      ]);
    };
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now - 120000, first]);
    await withdrawn();
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now, first]);
    db.run("UPDATE runner_certificate SET accepted_until=? WHERE runner_id=?", [now, first]);
    await withdrawn();
    db.run("UPDATE runner_certificate SET accepted_until=? WHERE runner_id=?", [
      now + 600000,
      first,
    ]);
    db.run(
      "INSERT INTO runner_pairing(id,claim_hash,code_hash,csr,name,request_fingerprint,expires_at,runner_id) VALUES(?,?,?,?,?,?,?,?)",
      [first, first, first, "synthetic CSR", "Unclaimed", first, now + 600000, first],
    );
    await withdrawn();
    db.run("DELETE FROM runner_pairing WHERE id=?", [first]);
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
    await withdrawn();
    db.run("UPDATE runner SET workspace_id='workspace' WHERE id=?", [first]);
    db.run("UPDATE member_vm SET runner_id=?", [addRunner("other")]);
    await withdrawn();
    db.run("UPDATE member_vm SET runner_id=?", [first]);
    expect((await state()).vm.runner?.id).toBe(first);
    advanceLinearSessionGeneration(db, "session", { now });
    expect((await read(0)).status).toBe(404);
    insertAssignment(1);
    expect((await state(1)).vm).toMatchObject({
      state: "ready",
      runner: { id: first },
      machine: { name: "paws-member", reused: true },
    });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "observer",
      active: true,
      teamIds: ["team"],
      now: now + 1,
    });
    expect((await read(1)).status).toBe(404);
    for (const table of ["runner_command", "runner_work_grant", "work_item", "job"])
      expect(db.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  } finally {
    await server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
