import { eq } from "drizzle-orm";
import type { Db, Q } from "../src/db";
import { seed } from "./dialects";

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
