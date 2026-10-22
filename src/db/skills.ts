import type { Database } from "bun:sqlite";

/** Agents that load skills from their home directory. Every one of them supports skills today. */
export const SKILL_AGENTS = ["claude", "codex", "grok"] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

/** Where a skill came from. The resolved version lives on the pin, not here. */
export type SkillSource =
  | { kind: "npm"; package: string; subfolder?: string }
  | { kind: "git"; url: string; ref?: string; subfolder?: string }
  | { kind: "upload"; folder: string };

/** One registered skill, pinned to an exact version and bundle checksum. */
export type SkillPin = {
  name: string;
  source: SkillSource;
  /** Package version, full commit, or content checksum for an upload. */
  version: string;
  sha256: string;
  sizeBytes: number;
  agents: SkillAgent[];
  createdAt: number;
  updatedAt: number;
  /** Set once removed; runners uninstall the skill and the row stays as the tombstone. */
  removedAt: number | null;
};

type Row = {
  name: string;
  source: string;
  version: string;
  sha256: string;
  size_bytes: number;
  agents: string;
  created_at: number;
  updated_at: number;
  removed_at: number | null;
};

const COLUMNS = "name,source,version,sha256,size_bytes,agents,created_at,updated_at,removed_at";

function pin(row: Row): SkillPin {
  return {
    name: row.name,
    source: JSON.parse(row.source) as SkillSource,
    version: row.version,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    agents: JSON.parse(row.agents) as SkillAgent[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

/** Every skill, removed ones included so runners can uninstall them. */
export function listSkills(db: Database): SkillPin[] {
  return db
    .query<Row, []>(`SELECT ${COLUMNS} FROM agent_skill ORDER BY removed_at IS NOT NULL, name`)
    .all()
    .map(pin);
}

export function getSkill(db: Database, name: string): SkillPin | null {
  const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM agent_skill WHERE name=?`).get(name);
  return row ? pin(row) : null;
}

/** Insert or replace the pin. A re-added skill keeps its first `createdAt` and loses its tombstone. */
export function saveSkill(db: Database, skill: Omit<SkillPin, "createdAt" | "removedAt">): void {
  db.run(
    `INSERT INTO agent_skill(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(name) DO UPDATE SET source=excluded.source,version=excluded.version,
       sha256=excluded.sha256,size_bytes=excluded.size_bytes,agents=excluded.agents,
       updated_at=excluded.updated_at,removed_at=NULL`,
    [
      skill.name,
      JSON.stringify(skill.source),
      skill.version,
      skill.sha256,
      skill.sizeBytes,
      JSON.stringify(skill.agents),
      skill.updatedAt,
      skill.updatedAt,
    ],
  );
}

export function setSkillAgents(
  db: Database,
  name: string,
  agents: readonly SkillAgent[],
  now: number,
): void {
  db.run("UPDATE agent_skill SET agents=?,updated_at=? WHERE name=? AND removed_at IS NULL", [
    JSON.stringify(agents),
    now,
    name,
  ]);
}

export function markSkillRemoved(db: Database, name: string, now: number): void {
  db.run("UPDATE agent_skill SET removed_at=?,updated_at=? WHERE name=? AND removed_at IS NULL", [
    now,
    now,
    name,
  ]);
}
