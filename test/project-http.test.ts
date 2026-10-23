import { expect, test } from "bun:test";
import { createProjectHttp } from "../src/project-execution";
import { startServer } from "../src/server";
import { syncWorkspaceMember } from "../src/db";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { createProjectFixture } from "./local/project-fixture";

test("project HTTP admission uses workspace authentication, CSRF and exact approval generation", async () => {
  const f = createProjectFixture();
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const access = createWorkspaceAccess({
    db: f.db,
    publicUrl: origin,
    clientId: "fixture",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds: ["team"],
      }),
    },
  });
  const server = startServer({
    port,
    hostname: "127.0.0.1",
    db: f.db,
    workspaceAccess: access,
    projects: createProjectHttp({ db: f.db, tracker: f.tracker, projects: f.projects }),
  });
  const url = `http://127.0.0.1:${server.port}/api/projects`;
  const session = issueWorkspaceSession(f.db, { ...f.actor, now: Date.now() });
  const headers = {
    cookie: `${WORKSPACE_COOKIE}=${session.token}`,
    origin,
    "x-paws-csrf": session.session.csrfToken,
    "content-type": "application/json",
  };
  const post = (value: unknown, override = headers) =>
    fetch(url, {
      method: "POST",
      headers: override,
      body: JSON.stringify(value),
    });
  try {
    expect((await fetch(url)).status).toBe(401);
    expect(
      (
        await post(
          { action: "preview", selection: f.selection },
          {
            ...headers,
            "x-paws-csrf": "wrong",
          },
        )
      ).status,
    ).toBe(403);
    expect((await fetch(`${url}?workspaceId=another`, { headers })).status).toBe(403);
    const response = await post({ action: "preview", selection: f.selection });
    expect(response.status).toBe(200);
    const { approval } = (await response.json()) as {
      approval: { id: string; generation: string; preview: { includedIssueIds: string[] } };
    };
    expect(approval.preview.includedIssueIds).toEqual(["one", "two"]);
    expect(
      (await post({ action: "approve", id: approval.id, generation: "0".repeat(64) })).status,
    ).toBe(409);
    expect(
      (await post({ action: "approve", id: approval.id, generation: approval.generation })).status,
    ).toBe(200);
    expect(f.db.query("SELECT issue_id FROM project_approval_issue").all()).toHaveLength(2);
    f.projects.register(f.jobs);
    await f.jobs.tick();
    f.db.run("UPDATE workspace_member SET active=0 WHERE user_id='lead'");
    f.db.run("DELETE FROM workspace_repository");
    const held = (await (await fetch(url, { headers })).json()) as {
      approvals: { id: string; lastError: string | null }[];
    };
    expect(held.approvals).toHaveLength(1);
    expect(held.approvals[0]?.lastError).toContain("access");
    expect((await post({ action: "pause", id: approval.id })).status).toBe(200);
    expect((await post({ action: "resume", id: approval.id })).status).toBe(409);
    f.db.run("DELETE FROM workspace_user_team WHERE user_id='actor'");
    expect(
      ((await (await fetch(url, { headers })).json()) as { approvals: unknown[] }).approvals,
    ).toEqual([]);
    expect((await post({ action: "stop", id: approval.id })).status).toBe(409);
    f.db.run(
      "INSERT INTO workspace_user_team(workspace_id,user_id,team_id) VALUES('workspace','actor','team')",
    );
    expect((await post({ action: "stop", id: approval.id })).status).toBe(200);
    expect(f.db.query("SELECT id FROM work_item WHERE state='cancelled'").all()).toHaveLength(1);
    syncWorkspaceMember(f.db, {
      ...f.actor,
      role: "observer",
      active: true,
      teamIds: ["team"],
      now: Date.now(),
    });
    expect((await fetch(url, { headers })).status).toBe(403);
    expect(
      f.db.query("SELECT action FROM workspace_access_audit WHERE action='access.denied'").all()
        .length,
    ).toBeGreaterThanOrEqual(4);
  } finally {
    await server.stop(true);
    await f.close();
  }
});
