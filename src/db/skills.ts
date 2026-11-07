import type { Database } from "bun:sqlite";
import { and, asc, eq, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { HookEvent } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonText, jsonValue } from "./json-text";

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

function* pinsSteps(q: Q, name?: string) {
  const { agentSkill } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        name: agentSkill.name,
        source: jsonText(q, agentSkill.source),
        version: agentSkill.version,
        sha256: agentSkill.sha256,
        sizeBytes: agentSkill.sizeBytes,
        agents: jsonText(q, agentSkill.agents),
        createdAt: agentSkill.createdAt,
        updatedAt: agentSkill.updatedAt,
        removedAt: agentSkill.removedAt,
      })
      .from(agentSkill)
      .where(name === undefined ? undefined : eq(agentSkill.name, name))
      .orderBy(asc(sql`${agentSkill.removedAt} IS NOT NULL`), asc(agentSkill.name)),
  );
  return rows.map((row): SkillPin => ({
    ...row,
    source: JSON.parse(row.source) as SkillSource,
    agents: JSON.parse(row.agents) as SkillAgent[],
  }));
}

export function* listSkillsSteps(q: Q): Steps<SkillPin[]> {
  return yield* pinsSteps(q);
}

/** Every skill, removed ones included so runners can uninstall them. */
export function listSkills(db: Database): SkillPin[] {
  return settled(sqliteDb(db).run(listSkillsSteps));
}

export function* getSkillSteps(q: Q, name: string) {
  const [pin] = yield* pinsSteps(q, name);
  return pin ?? null;
}

export function getSkill(db: Database, name: string): SkillPin | null {
  return settled(sqliteDb(db).run((q) => getSkillSteps(q, name)));
}

export function* saveSkillSteps(q: Q, skill: Omit<SkillPin, "createdAt" | "removedAt">) {
  const { agentSkill } = q.t;
  yield* q.exec(
    q.orm
      .insert(agentSkill)
      .values({
        name: skill.name,
        source: jsonValue(q, skill.source),
        version: skill.version,
        sha256: skill.sha256,
        sizeBytes: skill.sizeBytes,
        agents: jsonValue(q, skill.agents),
        createdAt: skill.updatedAt,
        updatedAt: skill.updatedAt,
        removedAt: null,
      })
      .onConflictDoUpdate({
        target: agentSkill.name,
        set: {
          source: sql`excluded.source`,
          version: sql`excluded.version`,
          sha256: sql`excluded.sha256`,
          sizeBytes: sql`excluded.size_bytes`,
          agents: sql`excluded.agents`,
          updatedAt: sql`excluded.updated_at`,
          removedAt: null,
        },
      }),
  );
}

/** Insert or replace the pin. A re-added skill keeps its first `createdAt` and loses its tombstone. */
export function saveSkill(db: Database, skill: Omit<SkillPin, "createdAt" | "removedAt">): void {
  settled(sqliteDb(db).run((q) => saveSkillSteps(q, skill)));
}

export function* setSkillAgentsSteps(
  q: Q,
  name: string,
  agents: readonly SkillAgent[],
  now: number,
) {
  const { agentSkill } = q.t;
  yield* q.exec(
    q.orm
      .update(agentSkill)
      .set({ agents: jsonValue(q, agents), updatedAt: now })
      .where(and(eq(agentSkill.name, name), isNull(agentSkill.removedAt))),
  );
}

export function setSkillAgents(
  db: Database,
  name: string,
  agents: readonly SkillAgent[],
  now: number,
): void {
  settled(sqliteDb(db).run((q) => setSkillAgentsSteps(q, name, agents, now)));
}

export function* markSkillRemovedSteps(q: Q, name: string, now: number) {
  const { agentSkill } = q.t;
  yield* q.exec(
    q.orm
      .update(agentSkill)
      .set({ removedAt: now, updatedAt: now })
      .where(and(eq(agentSkill.name, name), isNull(agentSkill.removedAt))),
  );
}

export function markSkillRemoved(db: Database, name: string, now: number): void {
  settled(sqliteDb(db).run((q) => markSkillRemovedSteps(q, name, now)));
}

/** A skill as a runner last reported it in its heartbeat. */
export type RunnerSkillStatus = {
  name: string;
  version: string;
  sha256: string;
  status: "installed" | "pending" | "refused";
  error: string | null;
  waiting: number | null;
  reportedAt: number;
};

type ReportedSkill = Omit<RunnerSkillStatus, "reportedAt" | "error" | "waiting"> & {
  error?: string;
  waiting?: number;
};

export function* recordRunnerSkillsSteps(
  q: Q,
  runnerId: string,
  skills: readonly ReportedSkill[],
  reportedAt: number,
) {
  const { agentSkill, runner, runnerSkill } = q.t;
  yield* q.exec(q.orm.delete(runnerSkill).where(eq(runnerSkill.runnerId, runnerId)));
  for (const skill of skills)
    yield* q.exec(
      q.orm.insert(runnerSkill).values({
        runnerId,
        name: skill.name,
        version: skill.version,
        sha256: skill.sha256,
        status: skill.status,
        error: skill.status === "refused" ? (skill.error ?? null) : null,
        waiting: skill.status === "pending" ? (skill.waiting ?? null) : null,
        reportedAt,
      }),
    );
  // A removed skill's tombstone goes once no live runner still has it.
  yield* q.exec(
    q.orm
      .delete(agentSkill)
      .where(
        and(
          isNotNull(agentSkill.removedAt),
          notInArray(
            agentSkill.name,
            q.orm
              .select({ name: runnerSkill.name })
              .from(runnerSkill)
              .innerJoin(runner, eq(runner.id, runnerSkill.runnerId))
              .where(isNull(runner.revokedAt)),
          ),
        ),
      ),
  );
}

/** Replace what the runner reported last; skills it no longer lists are gone from it. */
export function recordRunnerSkills(
  db: Database,
  runnerId: string,
  skills: readonly ReportedSkill[],
  reportedAt: number,
): void {
  settled(sqliteDb(db).run((q) => recordRunnerSkillsSteps(q, runnerId, skills, reportedAt)));
}

export function* listRunnerSkillsSteps(q: Q, runnerId: string) {
  const { runnerSkill } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        name: runnerSkill.name,
        version: runnerSkill.version,
        sha256: runnerSkill.sha256,
        status: runnerSkill.status,
        error: runnerSkill.error,
        waiting: runnerSkill.waiting,
        reportedAt: runnerSkill.reportedAt,
      })
      .from(runnerSkill)
      .where(eq(runnerSkill.runnerId, runnerId))
      .orderBy(asc(runnerSkill.name)),
  );
  return rows as RunnerSkillStatus[];
}

export function listRunnerSkills(db: Database, runnerId: string): RunnerSkillStatus[] {
  return settled(sqliteDb(db).run((q) => listRunnerSkillsSteps(q, runnerId)));
}

export type RunnerSkillState = "up_to_date" | "installing" | "out_of_date" | "failed";

export type RunnerSkillView = {
  name: string;
  version: string;
  installedVersion: string | null;
  state: RunnerSkillState;
  error: string | null;
  waiting: number | null;
  reportedAt: number | null;
};

export function* runnerSkillStatesSteps(
  q: Q,
  runnerId: string,
  pins?: readonly SkillPin[],
): Steps<RunnerSkillView[]> {
  const pinned = pins ?? (yield* listSkillsSteps(q));
  const reported = new Map(
    (yield* listRunnerSkillsSteps(q, runnerId)).map((row) => [row.name, row]),
  );
  return pinned
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
        waiting: current && state === "installing" ? row.waiting : null,
        reportedAt: row?.reportedAt ?? null,
      };
    });
}

export function runnerSkillStates(
  db: Database,
  runnerId: string,
  pins?: readonly SkillPin[],
): RunnerSkillView[] {
  return settled(sqliteDb(db).run((q) => runnerSkillStatesSteps(q, runnerId, pins)));
}

export type SkillRollout = {
  name: string;
  total: number;
  upToDate: number;
  installing: string[];
  waiting: { runner: string; tasks: number }[];
  outOfDate: string[];
  failed: string[];
};

export function* skillRolloutsSteps(q: Q, pins?: readonly SkillPin[]): Steps<SkillRollout[]> {
  const { runner } = q.t;
  const pinned = pins ?? (yield* listSkillsSteps(q));
  const runners = yield* q.all(
    q.orm
      .select({ id: runner.id, name: runner.name })
      .from(runner)
      .where(and(isNull(runner.revokedAt), ne(runner.status, "revoked")))
      .orderBy(asc(runner.createdAt), asc(runner.id)),
  );
  const rollouts = new Map<string, SkillRollout>(
    pinned
      .filter((entry) => entry.removedAt === null)
      .map((entry) => [
        entry.name,
        {
          name: entry.name,
          total: 0,
          upToDate: 0,
          installing: [],
          waiting: [],
          outOfDate: [],
          failed: [],
        },
      ]),
  );
  for (const live of runners)
    for (const skill of yield* runnerSkillStatesSteps(q, live.id, pinned)) {
      const rollout = rollouts.get(skill.name)!;
      rollout.total += 1;
      if (skill.state === "up_to_date") rollout.upToDate += 1;
      else if (skill.waiting) rollout.waiting.push({ runner: live.name, tasks: skill.waiting });
      else if (skill.state === "installing") rollout.installing.push(live.name);
      else if (skill.state === "out_of_date") rollout.outOfDate.push(live.name);
      else rollout.failed.push(live.name);
    }
  return [...rollouts.values()];
}

export function skillRollouts(db: Database, pins?: readonly SkillPin[]): SkillRollout[] {
  return settled(sqliteDb(db).run((q) => skillRolloutsSteps(q, pins)));
}

export type RunHook = { name: string; event: HookEvent };

export type RunAgentSetup = {
  runnerId: string;
  skills: { name: string; version: string; status: "installed" | "pending" }[];
  hooks: RunHook[];
  recordedAt: number;
};

type AgentSetupInput = {
  runId: string;
  runnerId: string;
  agent: string;
  hooks: RunHook[];
  at: number;
};

export function* recordRunAgentSetupSteps(q: Q, input: AgentSetupInput) {
  const { runAgentSetup } = q.t;
  const pins = new Map(
    (yield* listSkillsSteps(q))
      .filter(
        (entry) => entry.removedAt === null && entry.agents.includes(input.agent as SkillAgent),
      )
      .map((entry) => [entry.name, entry]),
  );
  const skills = (yield* listRunnerSkillsSteps(q, input.runnerId))
    .filter((row) => pins.has(row.name) && row.status !== "refused")
    .map((row) => ({
      name: row.name,
      version: row.version,
      status: row.status as "installed" | "pending",
    }));
  // `skills` and `hooks` are text columns on both dialects.
  yield* q.exec(
    q.orm
      .insert(runAgentSetup)
      .values({
        runId: input.runId,
        runnerId: input.runnerId,
        skills: JSON.stringify(skills),
        hooks: JSON.stringify(input.hooks),
        recordedAt: input.at,
      })
      .onConflictDoUpdate({
        target: runAgentSetup.runId,
        set: {
          runnerId: sql`excluded.runner_id`,
          skills: sql`excluded.skills`,
          hooks: sql`excluded.hooks`,
          recordedAt: sql`excluded.recorded_at`,
        },
      }),
  );
}

export function recordRunAgentSetup(db: Database, input: AgentSetupInput): void {
  settled(sqliteDb(db).run((q) => recordRunAgentSetupSteps(q, input)));
}

export function* runAgentSetupSteps(q: Q, runId: string): Steps<RunAgentSetup | null> {
  const { runAgentSetup } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runnerId: runAgentSetup.runnerId,
        skills: runAgentSetup.skills,
        hooks: runAgentSetup.hooks,
        recordedAt: runAgentSetup.recordedAt,
      })
      .from(runAgentSetup)
      .where(eq(runAgentSetup.runId, runId)),
  );
  return row
    ? {
        runnerId: row.runnerId,
        skills: JSON.parse(row.skills) as RunAgentSetup["skills"],
        hooks: JSON.parse(row.hooks) as RunHook[],
        recordedAt: row.recordedAt,
      }
    : null;
}

export function runAgentSetup(db: Database, runId: string): RunAgentSetup | null {
  return settled(sqliteDb(db).run((q) => runAgentSetupSteps(q, runId)));
}
