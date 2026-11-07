import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { orm } from "./orm";
import { agentCatalogRefresh, agentVersion, npmPackage, npmPackageVersion } from "./schema";
import { immediate } from "./tx";

/** What Paws keeps from one version in an npm registry document. */
export type NpmVersionMetadata = {
  /** `time[<version>]` in epoch milliseconds; null when the registry does not list it. */
  publishedAt: number | null;
  /** `dist.integrity`; null when the registry does not list it. */
  integrity: string | null;
  /** The `deprecated` message; null when the version is not deprecated. */
  deprecated: string | null;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
};

export type StoredNpmPackage = {
  etag: string | null;
  fetchedAt: number;
  versions: Record<string, NpmVersionMetadata>;
};

export type NpmIntegrityRecord = {
  integrity: string;
  firstSeenAt: number;
  /** The different integrity the registry later reported, if it ever did. Never cleared. */
  changedIntegrity: string | null;
};

export type AgentVersionStatus = "eligible" | "waiting" | "ineligible" | "refused";

export type AgentVersionRow = {
  agent: string;
  version: string;
  publishedAt: number | null;
  integrity: string;
  status: AgentVersionStatus;
  firstSeenAt: number;
  /** Why the version is not eligible; null when it is. */
  reason: string | null;
  /** The native build package version this agent version installs, when known. */
  nativeVersion: string | null;
  checkedAt: number;
};

export function readNpmPackage(db: Database, name: string): StoredNpmPackage | null {
  const row = orm(db)
    .select({
      etag: npmPackage.etag,
      fetchedAt: npmPackage.fetchedAt,
      versions: npmPackage.versions,
    })
    .from(npmPackage)
    .where(eq(npmPackage.package, name))
    .get();
  if (!row) return null;
  return {
    etag: row.etag,
    fetchedAt: row.fetchedAt,
    versions: JSON.parse(row.versions) as Record<string, NpmVersionMetadata>,
  };
}

/**
 * Store a freshly fetched registry document. The first integrity seen for each version is kept;
 * a later, different integrity is recorded once and never cleared.
 */
export function saveNpmPackage(
  db: Database,
  name: string,
  etag: string | null,
  versions: Record<string, NpmVersionMetadata>,
  now: number,
): void {
  immediate(db, () => {
    const stored = { etag, fetchedAt: now, versions: JSON.stringify(versions) };
    orm(db)
      .insert(npmPackage)
      .values({ package: name, ...stored })
      .onConflictDoUpdate({ target: npmPackage.package, set: stored })
      .run();
    for (const [version, metadata] of Object.entries(versions))
      if (metadata.integrity !== null)
        orm(db)
          .insert(npmPackageVersion)
          .values({ package: name, version, integrity: metadata.integrity, firstSeenAt: now })
          .onConflictDoUpdate({
            target: [npmPackageVersion.package, npmPackageVersion.version],
            set: { changedIntegrity: metadata.integrity, changedAt: now },
            setWhere: and(
              isNull(npmPackageVersion.changedIntegrity),
              sql`${npmPackageVersion.integrity} <> excluded.integrity`,
            ),
          })
          .run();
  });
}

/** Record a 304: the stored document is still current. */
export function touchNpmPackage(db: Database, name: string, now: number): void {
  orm(db).update(npmPackage).set({ fetchedAt: now }).where(eq(npmPackage.package, name)).run();
}

export function readNpmIntegrity(
  db: Database,
  name: string,
  version: string,
): NpmIntegrityRecord | null {
  return (
    orm(db)
      .select({
        integrity: npmPackageVersion.integrity,
        firstSeenAt: npmPackageVersion.firstSeenAt,
        changedIntegrity: npmPackageVersion.changedIntegrity,
      })
      .from(npmPackageVersion)
      .where(and(eq(npmPackageVersion.package, name), eq(npmPackageVersion.version, version)))
      .get() ?? null
  );
}

/** Replace the catalog rows of one agent. A version no longer reported keeps its last row. */
export function saveAgentVersions(db: Database, rows: readonly AgentVersionRow[]): void {
  immediate(db, () => {
    for (const row of rows)
      orm(db)
        .insert(agentVersion)
        .values(row)
        .onConflictDoUpdate({
          target: [agentVersion.agent, agentVersion.version],
          // The first integrity seen stays.
          set: {
            publishedAt: row.publishedAt,
            status: row.status,
            reason: row.reason,
            nativeVersion: row.nativeVersion,
            checkedAt: row.checkedAt,
          },
        })
        .run();
  });
}

export function readAgentVersion(
  db: Database,
  agent: string,
  version: string,
): AgentVersionRow | null {
  return settled(sqliteDb(db).run((q) => readAgentVersionSteps(q, agent, version)));
}

export function* readAgentVersionSteps(q: Q, agent: string, version: string) {
  const { agentVersion } = q.t;
  const row = yield* q.one(
    q.orm
      .select(agentVersionColumns(q))
      .from(agentVersion)
      .where(and(eq(agentVersion.agent, agent), eq(agentVersion.version, version))),
  );
  return row ?? null;
}

/** The catalog, newest publication first within each agent. */
export function listAgentVersions(db: Database, agent?: string): AgentVersionRow[] {
  return settled(sqliteDb(db).run((q) => listAgentVersionsSteps(q, agent)));
}

function* listAgentVersionsSteps(q: Q, agent?: string) {
  const { agentVersion } = q.t;
  return yield* q.all(
    q.orm
      .select(agentVersionColumns(q))
      .from(agentVersion)
      .where(agent === undefined ? undefined : eq(agentVersion.agent, agent))
      .orderBy(
        asc(agentVersion.agent),
        sql`${agentVersion.publishedAt} DESC NULLS LAST`,
        desc(agentVersion.version),
      ),
  );
}

/** When the last complete refresh of the agent catalog ran, or null before the first one. */
export function lastAgentCatalogRefresh(db: Database): number | null {
  return (
    orm(db)
      .select({ at: agentCatalogRefresh.completedAt })
      .from(agentCatalogRefresh)
      .where(eq(agentCatalogRefresh.id, 1))
      .get()?.at ?? null
  );
}

/** Record a refresh in which every agent was evaluated on fresh npm reads. */
export function markAgentCatalogRefreshed(db: Database, at: number): void {
  orm(db)
    .insert(agentCatalogRefresh)
    .values({ id: 1, completedAt: at })
    .onConflictDoUpdate({ target: agentCatalogRefresh.id, set: { completedAt: at } })
    .run();
}

function agentVersionColumns({ t: { agentVersion } }: Q) {
  return {
    agent: agentVersion.agent,
    version: agentVersion.version,
    publishedAt: agentVersion.publishedAt,
    integrity: agentVersion.integrity,
    status: sql<AgentVersionStatus>`${agentVersion.status}`,
    firstSeenAt: agentVersion.firstSeenAt,
    reason: agentVersion.reason,
    nativeVersion: agentVersion.nativeVersion,
    checkedAt: agentVersion.checkedAt,
  };
}

/** What the Runners page shows per agent: the newest version on offer and each refusal with its reason. */
export type AgentCatalogSummary = {
  agent: string;
  /** The newest eligible version, or null when none is eligible yet. */
  offered: string | null;
  refused: { version: string; reason: string }[];
  checkedAt: number;
};

export function agentCatalogSummary(db: Database): AgentCatalogSummary[] {
  return settled(sqliteDb(db).run(agentCatalogSummarySteps));
}

export function* agentCatalogSummarySteps(q: Q) {
  const byAgent = new Map<string, AgentCatalogSummary>();
  for (const row of yield* listAgentVersionsSteps(q)) {
    let entry = byAgent.get(row.agent);
    if (!entry)
      byAgent.set(
        row.agent,
        (entry = { agent: row.agent, offered: null, refused: [], checkedAt: row.checkedAt }),
      );
    entry.checkedAt = Math.max(entry.checkedAt, row.checkedAt);
    if (
      row.status === "eligible" &&
      (entry.offered === null || Bun.semver.order(row.version, entry.offered) > 0)
    )
      entry.offered = row.version;
    if (row.status === "refused" && entry.refused.length < 10)
      entry.refused.push({
        version: row.version,
        reason: row.reason ?? "Its integrity changed after Paws first saw it.",
      });
  }
  return [...byAgent.values()];
}
