import type { Database } from "bun:sqlite";
import type { HookEvent } from "../core";

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

/** A skill as a runner last reported it in its heartbeat. */
export type RunnerSkillStatus = {
  name: string;
  version: string;
  sha256: string;
  status: "installed" | "pending" | "refused";
  error: string | null;
  reportedAt: number;
};

/** Replace what the runner reported last; skills it no longer lists are gone from it. */
export function recordRunnerSkills(
  db: Database,
  runnerId: string,
  skills: readonly (Omit<RunnerSkillStatus, "reportedAt" | "error"> & { error?: string })[],
  reportedAt: number,
): void {
  db.run("DELETE FROM runner_skill WHERE runner_id=?", [runnerId]);
  for (const skill of skills)
    db.run(
      "INSERT INTO runner_skill(runner_id,name,version,sha256,status,error,reported_at) VALUES(?,?,?,?,?,?,?)",
      [
        runnerId,
        skill.name,
        skill.version,
        skill.sha256,
        skill.status,
        skill.status === "refused" ? (skill.error ?? null) : null,
        reportedAt,
      ],
    );
  db.run(
    `DELETE FROM agent_skill WHERE removed_at IS NOT NULL AND name NOT IN (
       SELECT s.name FROM runner_skill s JOIN runner r ON r.id=s.runner_id WHERE r.revoked_at IS NULL)`,
  );
}

export function listRunnerSkills(db: Database, runnerId: string): RunnerSkillStatus[] {
  return db
    .query<RunnerSkillStatus, [string]>(
      "SELECT name,version,sha256,status,error,reported_at AS reportedAt FROM runner_skill WHERE runner_id=? ORDER BY name",
    )
    .all(runnerId);
}

export type RunnerSkillState = "up_to_date" | "installing" | "out_of_date" | "failed";

export type RunnerSkillView = {
  name: string;
  version: string;
  installedVersion: string | null;
  state: RunnerSkillState;
  error: string | null;
  reportedAt: number | null;
};

export function runnerSkillStates(
  db: Database,
  runnerId: string,
  pins: readonly SkillPin[] = listSkills(db),
): RunnerSkillView[] {
  const reported = new Map(listRunnerSkills(db, runnerId).map((row) => [row.name, row]));
  return pins
    .filter((entry) => entry.removedAt === null)
    .map((entry) => {
      const row = reported.get(entry.name);
      const current = row?.sha256 === entry.sha256;
      const state: RunnerSkillState =
        row === undefined
          ? "installing"
          : current
            ? row.status === "installed"
              ? "up_to_date"
              : row.status === "pending"
                ? "installing"
                : "failed"
            : row.status === "refused"
              ? "installing"
              : "out_of_date";
      return {
        name: entry.name,
        version: entry.version,
        installedVersion: row && row.status !== "refused" ? row.version : null,
        state,
        error: state === "failed" ? row!.error : null,
        reportedAt: row?.reportedAt ?? null,
      };
    });
}

export type SkillRollout = {
  name: string;
  total: number;
  upToDate: number;
  installing: string[];
  outOfDate: string[];
  failed: string[];
};

export function skillRollouts(
  db: Database,
  pins: readonly SkillPin[] = listSkills(db),
): SkillRollout[] {
  const runners = db
    .query<{ id: string; name: string }, []>(
      "SELECT id,name FROM runner WHERE revoked_at IS NULL AND status<>'revoked' ORDER BY created_at,id",
    )
    .all();
  const rollouts = new Map<string, SkillRollout>(
    pins
      .filter((entry) => entry.removedAt === null)
      .map((entry) => [
        entry.name,
        { name: entry.name, total: 0, upToDate: 0, installing: [], outOfDate: [], failed: [] },
      ]),
  );
  for (const runner of runners)
    for (const skill of runnerSkillStates(db, runner.id, pins)) {
      const rollout = rollouts.get(skill.name)!;
      rollout.total += 1;
      if (skill.state === "up_to_date") rollout.upToDate += 1;
      else if (skill.state === "installing") rollout.installing.push(runner.name);
      else if (skill.state === "out_of_date") rollout.outOfDate.push(runner.name);
      else rollout.failed.push(runner.name);
    }
  return [...rollouts.values()];
}

export type RunHook = { name: string; event: HookEvent };

export type RunAgentSetup = {
  runnerId: string;
  skills: { name: string; version: string; status: "installed" | "pending" }[];
  hooks: RunHook[];
  recordedAt: number;
};

export function recordRunAgentSetup(
  db: Database,
  input: { runId: string; runnerId: string; agent: string; hooks: RunHook[]; at: number },
): void {
  const pins = new Map(
    listSkills(db)
      .filter(
        (entry) => entry.removedAt === null && entry.agents.includes(input.agent as SkillAgent),
      )
      .map((entry) => [entry.name, entry]),
  );
  const skills = listRunnerSkills(db, input.runnerId)
    .filter((row) => pins.has(row.name) && row.status !== "refused")
    .map((row) => ({
      name: row.name,
      version: row.version,
      status: row.status as "installed" | "pending",
    }));
  db.run(
    `INSERT INTO run_agent_setup(run_id,runner_id,skills,hooks,recorded_at) VALUES(?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET runner_id=excluded.runner_id,skills=excluded.skills,
       hooks=excluded.hooks,recorded_at=excluded.recorded_at`,
    [input.runId, input.runnerId, JSON.stringify(skills), JSON.stringify(input.hooks), input.at],
  );
}

export function runAgentSetup(db: Database, runId: string): RunAgentSetup | null {
  const row = db
    .query<{ runnerId: string; skills: string; hooks: string; recordedAt: number }, [string]>(
      "SELECT runner_id AS runnerId,skills,hooks,recorded_at AS recordedAt FROM run_agent_setup WHERE run_id=?",
    )
    .get(runId);
  return row
    ? {
        runnerId: row.runnerId,
        skills: JSON.parse(row.skills) as RunAgentSetup["skills"],
        hooks: JSON.parse(row.hooks) as RunHook[],
        recordedAt: row.recordedAt,
      }
    : null;
}
