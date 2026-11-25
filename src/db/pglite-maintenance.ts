import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { enqueueJobOnce } from "./jobs";

export const PGLITE_VACUUM_JOB = "db.pglite.vacuum";
export const PGLITE_VACUUM_EVERY_MS = 21_600_000;

function isPgliteStore(store: Db): boolean {
  return (store.orm as unknown as { $client?: unknown }).$client instanceof PGlite;
}

const failed = (what: string, error: unknown) =>
  `PGlite ${what} failed: ${error instanceof Error ? error.message : String(error)}`;

export async function maintainPglite(
  store: Db,
  jobs: { register(queue: string, handler: () => Promise<void>): void },
  log: (line: string) => void,
): Promise<void> {
  if (!isPgliteStore(store)) return;
  await store.orm.execute(sql`ANALYZE`).catch((error: unknown) => log(failed("ANALYZE", error)));
  jobs.register(PGLITE_VACUUM_JOB, async () => {
    await store.orm
      .execute(sql`VACUUM (ANALYZE)`)
      .catch((error: unknown) => log(failed("VACUUM (ANALYZE)", error)));
  });
  await enqueueJobOnce(store, {
    queue: PGLITE_VACUUM_JOB,
    jobKey: PGLITE_VACUUM_JOB,
    recurringEveryMs: PGLITE_VACUUM_EVERY_MS,
    runAt: Date.now() + PGLITE_VACUUM_EVERY_MS,
    now: Date.now(),
  }).catch((error: unknown) => log(failed("vacuum scheduling", error)));
}
