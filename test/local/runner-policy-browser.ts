import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import { createRunnerPlacementBrowser } from "../../src/runner-placement";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

export async function probeRunnerPolicyBrowser(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  const owner = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const token = issueWorkspaceBootstrap(db, "org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  const member = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: member,
    role: "member",
    active: true,
    teamIds: ["team"],
    now,
  });
  const runnerId = workspaceId();
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'Member host','active',?,?)",
    [runnerId, workspace.id, member, now, now],
  );
  const principal = (userId: string, role: WorkspacePrincipal["role"]): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId,
    role,
    authenticatedAt: now,
    teamIds: ["team"],
  });
  const browser = createRunnerPlacementBrowser({ db, now: () => now });
  const request = async (path: string, actor: WorkspacePrincipal, value?: unknown) =>
    browser(
      new Request("https://paws.example.invalid" + path, {
        method: value === undefined ? "GET" : "POST",
        ...(value === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
      }),
      actor,
    );
  const policy = { sharing: true };
  try {
    const memberPrincipal = principal(member, "member");
    assert.equal(
      (await request(`/api/runners/${runnerId}/policy`, memberPrincipal, policy))!.status,
      200,
    );
    assert.equal(
      (await request(`/api/runners/${runnerId}/policy`, principal(owner, "owner"), policy))!.status,
      403,
    );
    const saved = (await (await request(
      `/api/runners/${runnerId}/policy`,
      memberPrincipal,
    ))!.json()) as { sharing: number };
    assert.equal(saved.sharing, 1);
    observe(
      "The host owner can consent to sharing; an administrator cannot consent for them",
      true,
      { ownerSaved: true, administratorDenied: true },
    );
    for (const removed of [
      { agent: "codex", seat: "organization" },
      { hostOwner: "member" },
      { fallback: true },
    ])
      assert.equal(
        (await request(`/api/runners/${runnerId}/policy`, memberPrincipal, {
          ...policy,
          ...removed,
        }))!.status,
        400,
      );
    assert.equal(
      await request("/api/runners/policy", principal(owner, "owner"), {
        personalOrganizationHost: true,
      }),
      null,
    );
    observe(
      "Account type, workspace permission, host owner and fallback fields are no longer accepted",
      true,
      { removedFieldsRejected: true, workspacePolicyRouteRemoved: true },
    );
    assert.equal(
      (await request(
        `/api/runners/${runnerId}/policy`,
        { ...memberPrincipal, workspaceId: "other" },
        policy,
      ))!.status,
      403,
    );
    observe("Cross-workspace settings changes fail closed", true, { denied: 1 });
    const ownRunner = workspaceId();
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,'Owner host','active',?)",
      [ownRunner, workspace.id, owner, now],
    );
    for (const [id, userId, host] of [
      ["member-usage", member, runnerId],
      ["owner-usage", owner, ownRunner],
    ])
      db.run(
        "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,role,purpose,started_at,ended_at,outcome) VALUES(?,?,?,'implementer','helper',?,?,'success')",
        [id!, host!, userId!, now, now + 1000],
      );
    const privateUsage = (await (await request("/api/runners/usage", memberPrincipal))!.json()) as {
      usage: { ownerUserId: string }[];
    };
    const adminUsage = (await (await request(
      "/api/runners/usage",
      principal(owner, "owner"),
    ))!.json()) as { usage: unknown[] };
    assert.equal(privateUsage.usage.length, 1);
    assert.equal(privateUsage.usage[0]!.ownerUserId, member);
    assert.equal(adminUsage.usage.length, 2);
    const hostUsage = (await (await request(
      `/api/runners/usage?runner=${ownRunner}`,
      principal(owner, "owner"),
    ))!.json()) as { usage: { runnerId: string; commandId: string }[] };
    assert.deepEqual(
      hostUsage.usage.map((entry) => [entry.runnerId, entry.commandId]),
      [[ownRunner, "owner-usage"]],
    );
    observe("Execution usage is personal for members and workspace-wide for administrators", true, {
      memberRows: 1,
      ownerRows: 2,
      hostRows: 1,
    });
    db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [member]);
    assert.equal((await request("/api/runners/usage", memberPrincipal))!.status, 403);
    observe("Removed membership revokes both settings and usage access", true, { revoked: true });
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  const observations: unknown[] = [];
  await probeRunnerPolicyBrowser(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
}
