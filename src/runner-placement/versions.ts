import type { Database } from "bun:sqlite";
import { runnerVersionAtLeast, type RunnerVersion } from "../runner-protocol";

/** Read versions only for runners placement has already admitted as candidates. */
export function compatibleRunnerIds(
  db: Database,
  ids: readonly string[],
  minimum: RunnerVersion,
): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .query<{ id: string; version: string | null }, string[]>(
      `SELECT runner_id AS id,runner_version AS version FROM runner_host_status WHERE runner_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);
  return new Set(
    rows.filter((row) => runnerVersionAtLeast(row.version ?? "", minimum)).map((row) => row.id),
  );
}
