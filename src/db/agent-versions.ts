import type { Database } from "bun:sqlite";
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
  const row = db
    .query<{ etag: string | null; fetchedAt: number; versions: string }, [string]>(
      "SELECT etag, fetched_at AS fetchedAt, versions FROM npm_package WHERE package = ?",
    )
    .get(name);
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
    db.run(
      `INSERT INTO npm_package(package, etag, fetched_at, versions) VALUES (?, ?, ?, ?)
       ON CONFLICT(package) DO UPDATE SET etag = excluded.etag, fetched_at = excluded.fetched_at,
         versions = excluded.versions`,
      [name, etag, now, JSON.stringify(versions)],
    );
    const insert = db.prepare(
      `INSERT INTO npm_package_version(package, version, integrity, first_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(package, version) DO UPDATE SET
         changed_integrity = excluded.integrity, changed_at = ?
       WHERE npm_package_version.changed_integrity IS NULL
         AND npm_package_version.integrity <> excluded.integrity`,
    );
    for (const [version, metadata] of Object.entries(versions))
      if (metadata.integrity !== null) insert.run(name, version, metadata.integrity, now, now);
  });
}

/** Record a 304: the stored document is still current. */
export function touchNpmPackage(db: Database, name: string, now: number): void {
  db.run("UPDATE npm_package SET fetched_at = ? WHERE package = ?", [now, name]);
}

export function readNpmIntegrity(
  db: Database,
  name: string,
  version: string,
): NpmIntegrityRecord | null {
  return (
    db
      .query<NpmIntegrityRecord, [string, string]>(
        `SELECT integrity, first_seen_at AS firstSeenAt, changed_integrity AS changedIntegrity
         FROM npm_package_version WHERE package = ? AND version = ?`,
      )
      .get(name, version) ?? null
  );
}

/** Replace the catalog rows of one agent. A version no longer reported keeps its last row. */
export function saveAgentVersions(db: Database, rows: readonly AgentVersionRow[]): void {
  immediate(db, () => {
    const upsert = db.prepare(
      `INSERT INTO agent_version(agent, version, published_at, integrity, status, first_seen_at, reason,
         native_version, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent, version) DO UPDATE SET published_at = excluded.published_at,
         integrity = agent_version.integrity, status = excluded.status, reason = excluded.reason,
         native_version = excluded.native_version, checked_at = excluded.checked_at`,
    );
    for (const row of rows)
      upsert.run(
        row.agent,
        row.version,
        row.publishedAt,
        row.integrity,
        row.status,
        row.firstSeenAt,
        row.reason,
        row.nativeVersion,
        row.checkedAt,
      );
  });
}

export function readAgentVersion(
  db: Database,
  agent: string,
  version: string,
): AgentVersionRow | null {
  return (
    db
      .query<AgentVersionRow, [string, string]>(
        `${SELECT_AGENT_VERSION} WHERE agent = ? AND version = ?`,
      )
      .get(agent, version) ?? null
  );
}

/** The catalog, newest publication first within each agent. */
export function listAgentVersions(db: Database, agent?: string): AgentVersionRow[] {
  const order = "ORDER BY agent, published_at DESC, version DESC";
  return agent === undefined
    ? db.query<AgentVersionRow, []>(`${SELECT_AGENT_VERSION} ${order}`).all()
    : db
        .query<AgentVersionRow, [string]>(`${SELECT_AGENT_VERSION} WHERE agent = ? ${order}`)
        .all(agent);
}

/** When the agent catalog was last evaluated, or null before the first refresh. */
export function lastAgentCatalogCheck(db: Database): number | null {
  return (
    db.query<{ at: number | null }, []>("SELECT max(checked_at) AS at FROM agent_version").get()
      ?.at ?? null
  );
}

const SELECT_AGENT_VERSION = `SELECT agent, version, published_at AS publishedAt, integrity, status,
  first_seen_at AS firstSeenAt, reason, native_version AS nativeVersion, checked_at AS checkedAt
  FROM agent_version`;

/** What the Runners page shows per agent: the newest version on offer and each refusal with its reason. */
export type AgentCatalogSummary = {
  agent: string;
  /** The newest eligible version, or null when none is eligible yet. */
  offered: string | null;
  refused: { version: string; reason: string }[];
  checkedAt: number;
};

export function agentCatalogSummary(db: Database): AgentCatalogSummary[] {
  const byAgent = new Map<string, AgentCatalogSummary>();
  for (const row of listAgentVersions(db)) {
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
