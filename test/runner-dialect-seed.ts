import type { Q } from "../src/db";

export function* insertRunnerSteps(q: Q, runnerId: string, workspaceId = "acme", createdAt = 0) {
  const { runner, workspace, workspaceMember, workspaceUser } = q.t;
  yield* q.exec(
    q.orm
      .insert(workspace)
      .values({
        id: workspaceId,
        linearOrganizationId: `org-${workspaceId}`,
        name: workspaceId,
        createdAt: 0,
      })
      .onConflictDoNothing(),
  );
  yield* q.exec(
    q.orm
      .insert(workspaceUser)
      .values({ id: "owner", linearUserId: "linear-owner", name: "Ada", email: "ada@example.com" })
      .onConflictDoNothing(),
  );
  yield* q.exec(
    q.orm
      .insert(workspaceMember)
      .values({
        workspaceId,
        userId: "owner",
        role: "owner",
        source: "linear",
        active: 1,
        checkedAt: 0,
      })
      .onConflictDoNothing(),
  );
  yield* q.exec(
    q.orm.insert(runner).values({
      id: runnerId,
      workspaceId,
      ownerUserId: "owner",
      name: runnerId,
      status: "active",
      createdAt,
    }),
  );
}
