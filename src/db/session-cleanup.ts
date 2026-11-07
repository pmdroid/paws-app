import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { linearSessionCleanupBlock } from "./schema";

export function blockLinearSessionCleanup(db: Database, sessionId: string): void {
  orm(db).insert(linearSessionCleanupBlock).values({ sessionId }).onConflictDoNothing().run();
}

export function assertLinearSessionCleanup(db: Database, sessionId?: string): void {
  const blocked = orm(db)
    .select({ one: sql`1` })
    .from(linearSessionCleanupBlock)
    .where(sessionId ? eq(linearSessionCleanupBlock.sessionId, sessionId) : undefined)
    .limit(1)
    .get();
  if (blocked) throw new Error("ACP process cleanup could not be verified");
}
