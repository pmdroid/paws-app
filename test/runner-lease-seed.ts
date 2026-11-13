import { putWorkspaceUser, syncWorkspaceMember, type Db } from "../src/db";

export async function seedRunnerLease(
  db: Db,
  runId: string,
  options: { teardownConfirmed?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws-1", linearOrganizationId: "org-1", name: "Workspace", createdAt: now }),
    );
  });
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  await db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.runner).values({
        id: "runner-1",
        workspaceId: "ws-1",
        ownerUserId: userId,
        name: "Runner",
        status: "active",
        createdAt: now,
        lastSeenAt: now,
      }),
    );
    yield* q.exec(q.orm.insert(q.t.runnerCapacity).values({ runnerId: "runner-1", capacity: 1 }));
    yield* q.exec(
      q.orm.insert(q.t.runnerWork).values({
        runId,
        runnerId: "runner-1",
        workspaceId: "ws-1",
        generation: 1,
        runnerFence: 0,
        commandId: `cmd-${runId}`,
        leaseUntil: now + 60_000,
        lastSequence: 0,
        ...(options.teardownConfirmed ? { teardownConfirmedAt: now } : {}),
      }),
    );
  });
  return "runner-1";
}
