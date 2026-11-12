import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, putWorkspaceUser, syncWorkspaceMember } from "../../src/db";
import { createRunnerPlacementBrowser } from "../../src/runner-placement";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";
import { eq } from "drizzle-orm";
import { seed } from "../dialects";
import { tempStore } from "../pglite";

export async function probeRunnerPolicyBrowser(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const { db, close } = await tempStore();
  let now = Date.now();
  const admin = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "admin",
    name: "Admin",
    email: "admin@example.invalid",
  });
  const token = await issueWorkspaceBootstrap(db, "org", now);
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: admin,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  const member = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  await syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: member,
    role: "member",
    active: true,
    teamIds: ["team"],
    now,
  });
  const runnerId = workspaceId();
  await seed(db, (q) =>
    q.orm.insert(q.t.runner).values({
      id: runnerId,
      workspaceId: workspace.id,
      ownerUserId: member,
      name: "Member host",
      status: "active",
      createdAt: now,
      lastSeenAt: now,
    }),
  );
  const principal = (userId: string, role: WorkspacePrincipal["role"]): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId,
    role,
    authenticatedAt: now,
    teamIds: ["team"],
  });
  const browser = createRunnerPlacementBrowser({ store: db, now: () => now });
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
      (await request(`/api/runners/${runnerId}/policy`, principal(admin, "admin"), policy))!.status,
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
      await request("/api/runners/policy", principal(admin, "admin"), {
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
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: ownRunner,
          workspaceId: workspace.id,
          ownerUserId: admin,
          name: "Admin host",
          status: "active",
          createdAt: now,
        }),
      (q) =>
        q.orm.insert(q.t.runnerExecutionUsage).values(
          [
            ["member-usage", member, runnerId],
            ["admin-usage", admin, ownRunner],
          ].map(([commandId, ownerUserId, host]) => ({
            commandId: commandId!,
            runnerId: host!,
            ownerUserId: ownerUserId!,
            role: "implementer",
            purpose: "helper",
            startedAt: now,
            endedAt: now + 1000,
            outcome: "success",
          })),
        ),
    );
    const privateUsage = (await (await request("/api/runners/usage", memberPrincipal))!.json()) as {
      usage: { ownerUserId: string }[];
    };
    const adminUsage = (await (await request(
      "/api/runners/usage",
      principal(admin, "admin"),
    ))!.json()) as { usage: unknown[] };
    assert.equal(privateUsage.usage.length, 1);
    assert.equal(privateUsage.usage[0]!.ownerUserId, member);
    assert.equal(adminUsage.usage.length, 2);
    const hostUsage = (await (await request(
      `/api/runners/usage?runner=${ownRunner}`,
      principal(admin, "admin"),
    ))!.json()) as { usage: { runnerId: string; commandId: string }[] };
    assert.deepEqual(
      hostUsage.usage.map((entry) => [entry.runnerId, entry.commandId]),
      [[ownRunner, "admin-usage"]],
    );
    observe("Execution usage is personal for members and workspace-wide for administrators", true, {
      memberRows: 1,
      adminRows: 2,
      hostRows: 1,
    });
    await db.run(function* (q) {
      yield* q.exec(
        q.orm
          .update(q.t.workspaceMember)
          .set({ active: 0 })
          .where(eq(q.t.workspaceMember.userId, member)),
      );
    });
    assert.equal((await request("/api/runners/usage", memberPrincipal))!.status, 403);
    observe("Removed membership revokes both settings and usage access", true, { revoked: true });
  } finally {
    await close();
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
