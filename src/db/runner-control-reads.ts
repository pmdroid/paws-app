import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, not, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { workspaceMemberUsableWhere } from "./workspace";

export function* liveRunnerSessionsSteps(
  q: Q,
  input: { runnerId: string; workspaceId: string; at: number; runId?: string },
) {
  const { runnerWork: w, run: r } = q.t;
  return yield* q.all(
    q.orm
      .select({ runId: w.runId, itemId: r.itemId })
      .from(w)
      .innerJoin(r, eq(r.id, w.runId))
      .where(
        and(
          eq(w.runnerId, input.runnerId),
          eq(w.workspaceId, input.workspaceId),
          isNull(w.endedAt),
          gt(w.leaseUntil, input.at),
          inArray(r.status, ["active", "provisioning"]),
          input.runId === undefined ? undefined : eq(w.runId, input.runId),
        ),
      )
      .orderBy(asc(r.createdAt), asc(w.runId)),
  );
}

export function* workspaceRunnerStatusSteps(
  q: Q,
  runnerId: string,
  workspaceId: string,
): Steps<string | null> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ status: runner.status })
      .from(runner)
      .where(and(eq(runner.id, runnerId), eq(runner.workspaceId, workspaceId))),
  );
  return row?.status ?? null;
}

export function* expiredRunnerCertificatesSteps(q: Q, now: number): Steps<string[]> {
  const { runnerCertificate: c, runner: r, workspaceMember: m } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ fingerprint: c.fingerprint })
      .from(c)
      .innerJoin(r, eq(r.id, c.runnerId))
      .innerJoin(m, and(eq(m.workspaceId, r.workspaceId), eq(m.userId, r.ownerUserId)))
      .where(
        or(
          isNotNull(c.revokedAt),
          lte(c.acceptedUntil, now),
          isNotNull(r.revokedAt),
          eq(r.status, "revoked"),
          not(workspaceMemberUsableWhere(m)!),
        ),
      ),
  );
  return rows.map((row) => row.fingerprint);
}

export function expiredRunnerCertificates(db: Database, now: number): string[] {
  return settled(sqliteDb(db).run((q) => expiredRunnerCertificatesSteps(q, now)));
}

export function* certificateRunnerRevokedSteps(q: Q, fingerprint: string): Steps<boolean> {
  const { runnerCertificate: c, runner: r } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(c)
      .innerJoin(r, eq(r.id, c.runnerId))
      .where(
        and(eq(c.fingerprint, fingerprint), or(isNotNull(r.revokedAt), eq(r.status, "revoked"))),
      ),
  );
  return row !== undefined;
}

export async function certificateRunnerRevoked(store: Db, fingerprint: string): Promise<boolean> {
  return store.run((q) => certificateRunnerRevokedSteps(q, fingerprint));
}
