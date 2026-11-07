import type { Database } from "bun:sqlite";
import { and, eq, gt, lte } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import type { browserInstallationRequest } from "./schema-pg";

type BrowserInstallation = typeof browserInstallationRequest.$inferSelect;

export function* saveBrowserInstallationSteps(q: Q, input: BrowserInstallation) {
  const { browserInstallationRequest: request } = q.t;
  yield* q.exec(q.orm.delete(request).where(lte(request.expiresAt, input.expiresAt - 600_000)));
  yield* q.exec(q.orm.insert(request).values(input));
}

export function saveBrowserInstallation(db: Database, input: BrowserInstallation): void {
  settled(sqliteDb(db).run((q) => saveBrowserInstallationSteps(q, input)));
}

export function* consumeBrowserInstallationSteps(
  q: Q,
  stateHash: string,
  browserHash: string,
  now: number,
) {
  const { browserInstallationRequest: request } = q.t;
  const row = yield* q.one(
    q.orm
      .delete(request)
      .where(
        and(
          eq(request.stateHash, stateHash),
          eq(request.browserHash, browserHash),
          gt(request.expiresAt, now),
        ),
      )
      .returning({ identity: request.identity }),
  );
  return row?.identity ?? null;
}

export function consumeBrowserInstallation(
  db: Database,
  stateHash: string,
  browserHash: string,
  now: number,
): string | null {
  return settled(
    sqliteDb(db).run((q) => consumeBrowserInstallationSteps(q, stateHash, browserHash, now)),
  );
}
