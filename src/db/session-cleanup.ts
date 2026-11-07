import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export function* blockLinearSessionCleanupSteps(q: Q, sessionId: string) {
  yield* q.exec(
    q.orm.insert(q.t.linearSessionCleanupBlock).values({ sessionId }).onConflictDoNothing(),
  );
}

export function blockLinearSessionCleanup(db: Database, sessionId: string): void {
  settled(sqliteDb(db).run((q) => blockLinearSessionCleanupSteps(q, sessionId)));
}

export function* assertLinearSessionCleanupSteps(q: Q, sessionId?: string) {
  const { linearSessionCleanupBlock } = q.t;
  const blocked = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(linearSessionCleanupBlock)
      .where(sessionId ? eq(linearSessionCleanupBlock.sessionId, sessionId) : undefined)
      .limit(1),
  );
  if (blocked) throw new Error("ACP process cleanup could not be verified");
}

export function assertLinearSessionCleanup(db: Database, sessionId?: string): void {
  settled(sqliteDb(db).run((q) => assertLinearSessionCleanupSteps(q, sessionId)));
}
