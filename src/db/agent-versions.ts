import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonText } from "./json-text";

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

export function* readNpmPackageSteps(q: Q, name: string) {
  const { npmPackage } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        etag: npmPackage.etag,
        fetchedAt: npmPackage.fetchedAt,
        versions: jsonText(q, npmPackage.versions),
      })
      .from(npmPackage)
      .where(eq(npmPackage.package, name)),
  );
  if (!row) return null;
  const stored: StoredNpmPackage = {
    etag: row.etag,
    fetchedAt: row.fetchedAt,
    versions: JSON.parse(row.versions) as Record<string, NpmVersionMetadata>,
  };
  return stored;
}

export async function readNpmPackage(store: Db, name: string): Promise<StoredNpmPackage | null> {
  return store.run((q) => readNpmPackageSteps(q, name));
}

export function* saveNpmPackageSteps(
  q: Q,
  name: string,
  etag: string | null,
  versions: Record<string, NpmVersionMetadata>,
  now: number,
) {
  const { npmPackage, npmPackageVersion } = q.t;
  const stored = {
    etag,
    fetchedAt: now,
    versions: q.dialect === "sqlite" ? JSON.stringify(versions) : versions,
  };
  yield* q.exec(
    q.orm
      .insert(npmPackage)
      .values({ package: name, ...stored })
      .onConflictDoUpdate({ target: npmPackage.package, set: stored }),
  );
  for (const [version, metadata] of Object.entries(versions))
    if (metadata.integrity !== null)
      yield* q.exec(
        q.orm
          .insert(npmPackageVersion)
          .values({ package: name, version, integrity: metadata.integrity, firstSeenAt: now })
          .onConflictDoUpdate({
            target: [npmPackageVersion.package, npmPackageVersion.version],
            set: { changedIntegrity: metadata.integrity, changedAt: now },
            setWhere: and(
              isNull(npmPackageVersion.changedIntegrity),
              sql`${npmPackageVersion.integrity} <> excluded.integrity`,
            ),
          }),
      );
}

/**
 * Store a freshly fetched registry document. The first integrity seen for each version is kept;
 * a later, different integrity is recorded once and never cleared.
 */
export async function saveNpmPackage(
  store: Db,
  name: string,
  etag: string | null,
  versions: Record<string, NpmVersionMetadata>,
  now: number,
): Promise<void> {
  await store.transaction((q) => saveNpmPackageSteps(q, name, etag, versions, now));
}

export function* touchNpmPackageSteps(q: Q, name: string, now: number) {
  const { npmPackage } = q.t;
  yield* q.exec(
    q.orm.update(npmPackage).set({ fetchedAt: now }).where(eq(npmPackage.package, name)),
  );
}

/** Record a 304: the stored document is still current. */
export async function touchNpmPackage(store: Db, name: string, now: number): Promise<void> {
  await store.run((q) => touchNpmPackageSteps(q, name, now));
}

export function* readNpmIntegritySteps(q: Q, name: string, version: string) {
  const { npmPackageVersion } = q.t;
  const row: NpmIntegrityRecord | undefined = yield* q.one(
    q.orm
      .select({
        integrity: npmPackageVersion.integrity,
        firstSeenAt: npmPackageVersion.firstSeenAt,
        changedIntegrity: npmPackageVersion.changedIntegrity,
      })
      .from(npmPackageVersion)
      .where(and(eq(npmPackageVersion.package, name), eq(npmPackageVersion.version, version))),
  );
  return row ?? null;
}

export async function readNpmIntegrity(
  store: Db,
  name: string,
  version: string,
): Promise<NpmIntegrityRecord | null> {
  return store.run((q) => readNpmIntegritySteps(q, name, version));
}

export function* saveAgentVersionsSteps(q: Q, rows: readonly AgentVersionRow[]) {
  const { agentVersion } = q.t;
  for (const row of rows)
    yield* q.exec(
      q.orm
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
        }),
    );
}

/** Replace the catalog rows of one agent. A version no longer reported keeps its last row. */
export async function saveAgentVersions(
  store: Db,
  rows: readonly AgentVersionRow[],
): Promise<void> {
  await store.transaction((q) => saveAgentVersionsSteps(q, rows));
}

function agentVersionColumns(q: Q) {
  const { agentVersion } = q.t;
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

export function* readAgentVersionSteps(q: Q, agent: string, version: string) {
  const { agentVersion } = q.t;
  const row: AgentVersionRow | undefined = yield* q.one(
    q.orm
      .select(agentVersionColumns(q))
      .from(agentVersion)
      .where(and(eq(agentVersion.agent, agent), eq(agentVersion.version, version))),
  );
  return row ?? null;
}

export async function readAgentVersion(
  store: Db,
  agent: string,
  version: string,
): Promise<AgentVersionRow | null> {
  return store.run((q) => readAgentVersionSteps(q, agent, version));
}

export function* listAgentVersionsSteps(q: Q, agent?: string) {
  const { agentVersion } = q.t;
  const rows: AgentVersionRow[] = yield* q.all(
    q.orm
      .select(agentVersionColumns(q))
      .from(agentVersion)
      .where(agent === undefined ? undefined : eq(agentVersion.agent, agent))
      // SQLite sorts NULL first and Postgres last; NULLS LAST keeps SQLite's DESC order on both.
      .orderBy(
        asc(agentVersion.agent),
        sql`${agentVersion.publishedAt} DESC NULLS LAST`,
        desc(agentVersion.version),
      ),
  );
  return rows;
}

/** The catalog, newest publication first within each agent. */
export async function listAgentVersions(store: Db, agent?: string): Promise<AgentVersionRow[]> {
  return store.run((q) => listAgentVersionsSteps(q, agent));
}

export function* lastAgentCatalogRefreshSteps(q: Q) {
  const { agentCatalogRefresh } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ at: agentCatalogRefresh.completedAt })
      .from(agentCatalogRefresh)
      .where(eq(agentCatalogRefresh.id, 1)),
  );
  return row?.at ?? null;
}

/** When the last complete refresh of the agent catalog ran, or null before the first one. */
export async function lastAgentCatalogRefresh(store: Db): Promise<number | null> {
  return store.run((q) => lastAgentCatalogRefreshSteps(q));
}

export function* markAgentCatalogRefreshedSteps(q: Q, at: number) {
  const { agentCatalogRefresh } = q.t;
  yield* q.exec(
    q.orm
      .insert(agentCatalogRefresh)
      .values({ id: 1, completedAt: at })
      .onConflictDoUpdate({ target: agentCatalogRefresh.id, set: { completedAt: at } }),
  );
}

/** Record a refresh in which every agent was evaluated on fresh npm reads. */
export async function markAgentCatalogRefreshed(store: Db, at: number): Promise<void> {
  await store.run((q) => markAgentCatalogRefreshedSteps(q, at));
}

/** What the Runners page shows per agent: the newest version on offer and each refusal with its reason. */
export type AgentCatalogSummary = {
  agent: string;
  /** The newest eligible version, or null when none is eligible yet. */
  offered: string | null;
  refused: { version: string; reason: string }[];
  checkedAt: number;
};

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

export async function agentCatalogSummary(store: Db): Promise<AgentCatalogSummary[]> {
  return store.run((q) => agentCatalogSummarySteps(q));
}
