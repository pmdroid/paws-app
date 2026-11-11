import { and, eq, gt, lte } from "drizzle-orm";
import { type Q, type Db } from "./db";
import type { browserInstallationRequest } from "./schema-pg";

type BrowserInstallation = typeof browserInstallationRequest.$inferSelect;

export function* saveBrowserInstallationSteps(q: Q, input: BrowserInstallation) {
  const { browserInstallationRequest: request } = q.t;
  yield* q.exec(q.orm.delete(request).where(lte(request.expiresAt, input.expiresAt - 600_000)));
  yield* q.exec(q.orm.insert(request).values(input));
}

export async function saveBrowserInstallation(
  store: Db,
  input: BrowserInstallation,
): Promise<void> {
  await store.run((q) => saveBrowserInstallationSteps(q, input));
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

export async function consumeBrowserInstallation(
  store: Db,
  stateHash: string,
  browserHash: string,
  now: number,
): Promise<string | null> {
  return store.run((q) => consumeBrowserInstallationSteps(q, stateHash, browserHash, now));
}
