import type { Database } from "bun:sqlite";
import { and, eq, gt, lte } from "drizzle-orm";
import { orm } from "./orm";
import { browserInstallationRequest } from "./schema";

export function saveBrowserInstallation(
  db: Database,
  input: { stateHash: string; browserHash: string; identity: string; expiresAt: number },
): void {
  orm(db)
    .delete(browserInstallationRequest)
    .where(lte(browserInstallationRequest.expiresAt, input.expiresAt - 600_000))
    .run();
  orm(db).insert(browserInstallationRequest).values(input).run();
}

export function consumeBrowserInstallation(
  db: Database,
  stateHash: string,
  browserHash: string,
  now: number,
): string | null {
  return (
    orm(db)
      .delete(browserInstallationRequest)
      .where(
        and(
          eq(browserInstallationRequest.stateHash, stateHash),
          eq(browserInstallationRequest.browserHash, browserHash),
          gt(browserInstallationRequest.expiresAt, now),
        ),
      )
      .returning({ identity: browserInstallationRequest.identity })
      .get()?.identity ?? null
  );
}
