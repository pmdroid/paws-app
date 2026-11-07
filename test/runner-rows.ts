import type { Db } from "../src/db";
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
