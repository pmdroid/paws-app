import { eq } from "drizzle-orm";
import type { Db, Q } from "../src/db";
import { json, seed } from "./dialects";

/** Rows the runner modules read, with defaults, seeded through Drizzle on either dialect. */
export function seedRunner(
  db: Db,
  id: string,
  row: { status?: string; revokedAt?: number; lastSeenAt?: number; liveReportedAt?: number } = {},
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runner).values({
      id,
      workspaceId: "acme",
      ownerUserId: "owner",
      name: id,
      status: "active",
      createdAt: 0,
      ...row,
    }),
  );
}

export function seedRun(db: Db, id: string, itemId: string, status = "active") {
  return seed(db, (q) =>
    q.orm.insert(q.t.run).values({
      id,
      itemId,
      kind: "implement",
      agent: "codex",
      status,
      createdAt: 0,
      updatedAt: 0,
    }),
  );
}

export function seedWork(
  db: Db,
  runId: string,
  runnerId: string,
  row: { generation?: number; commandId?: string; leaseUntil?: number; endedAt?: number } = {},
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerWork).values({
      runId,
      runnerId,
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil: Number.MAX_SAFE_INTEGER,
      ...row,
    }),
  );
}

export function seedCommand(
  db: Db,
  id: string,
  row: {
    runnerId: string;
    runId: string;
    kind: string;
    generation?: number;
    expiresAt?: number;
    acknowledgedAt?: number;
    envelope?: unknown;
  },
) {
  const { envelope = {}, ...rest } = row;
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerCommand).values({
      id,
      generation: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      envelope: json(db, envelope),
      ...rest,
    }),
  );
}

export function seedResult(
  db: Db,
  runId: string,
  commandId: string,
  payload: unknown,
  generation = 1,
) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.runnerResult)
      .values({ runId, generation, commandId, payload: json(db, payload), receivedAt: 0 }),
  );
}

export function addWorkspaceRepository(
  db: Db,
  workspaceId: string,
  repository: string,
  teamId: string,
): Promise<void> {
  return seed(db, (q) =>
    q.orm.insert(q.t.workspaceRepository).values({ workspaceId, repository, teamId }),
  );
}

export function setRunnerStatus(db: Db, runnerId: string, status: string): Promise<void> {
  return seed(db, (q) =>
    q.orm.update(q.t.runner).set({ status }).where(eq(q.t.runner.id, runnerId)),
  );
}

export function setItemOwner(db: Db, itemId: string, ownerUserId: string): Promise<void> {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId }).where(eq(q.t.workItem.id, itemId)),
  );
}

export async function activateRunner(
  db: Db,
  runnerId: string,
  options: { agents?: string[]; ready?: number; version?: string; now?: number } = {},
): Promise<void> {
  const { agents = ["claude"], ready = 1, version, now = Date.now() } = options;
  await setRunnerStatus(db, runnerId, "active");
  await seed(
    db,
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId }),
    ...agents.map(
      (agent) => (q: Q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent, ready }),
    ),
  );
  if (version !== undefined)
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId, runnerVersion: version, reportedAt: now }),
    );
}
