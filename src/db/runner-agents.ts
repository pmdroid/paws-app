import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";
import { agentCatalogSummary, readAgentVersion } from "./agent-versions";

type ReportedStatus = "current" | "previous" | "installing" | "waiting" | "failed";

/** A coding agent version as a runner reported it in its heartbeat. */
export type RunnerAgentReport = {
  agent: string;
  version: string;
  status: ReportedStatus;
  target?: string;
  sessions?: number;
  error?: string;
};

/** A package the catalog checked, with the integrity Paws first saw for it on npm. */
export type CatalogPackage = { name: string; version: string; integrity: string };

/** The native build package and its platform packages the catalog checked for an agent version. */
export type CatalogPackages = (agent: string, nativeVersion: string | null) => CatalogPackage[];

/** The version someone chose on the Runners page, sent to the runner until it runs it. */
export type RunnerAgentTargetRow = {
  id: string;
  agent: string;
  version: string;
  /** Null for a rollback: the runner switches back to a version it already has. */
  integrity: string | null;
  nativeVersion: string | null;
  /** The native and platform packages the runner must install with exactly these integrities. */
  packages: CatalogPackage[];
};

/** What the runner card shows for one coding agent. */
export type RunnerAgentView = {
  agent: string;
  /** The version new sessions start; null before the runner reports one. */
  current: string | null;
  /** The version it ran before, which Roll back switches to. */
  previous: string | null;
  /** The version asked for and how it is going, until the runner runs it. */
  pending: {
    version: string;
    rollback: boolean;
    /** `requested` until the runner picks it up. */
    status: "requested" | "installing" | "waiting" | "failed";
    /** Sessions still on the old version while `waiting`. */
    sessions: number | null;
    error: string | null;
    requestedAt: number;
  } | null;
  reportedAt: number | null;
};

/** A request the Runners page cannot make, with a message for the person who made it. */
export class RunnerAgentUpdateError extends Error {}

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const name = (agent: string) => NAMES[agent] ?? agent;

/** Replace what the runner reported last, and drop each target it now runs. */
export function recordRunnerAgents(
  db: Database,
  runnerId: string,
  agents: readonly RunnerAgentReport[],
  reportedAt: number,
): void {
  db.run("DELETE FROM runner_agent WHERE runner_id=?", [runnerId]);
  const insert = db.prepare(
    `INSERT INTO runner_agent(runner_id,agent,version,status,error,sessions,target_id,reported_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(runner_id,agent,status) DO NOTHING`,
  );
  for (const agent of agents)
    insert.run(
      runnerId,
      agent.agent,
      agent.version,
      agent.status,
      agent.status === "failed" ? (agent.error ?? null) : null,
      agent.status === "waiting" ? (agent.sessions ?? null) : null,
      agent.target ?? null,
      reportedAt,
    );
  db.run(
    `DELETE FROM runner_agent_target WHERE runner_id=? AND EXISTS (
       SELECT 1 FROM runner_agent a WHERE a.runner_id=runner_agent_target.runner_id
       AND a.agent=runner_agent_target.agent AND a.status='current'
       AND a.version=runner_agent_target.version)`,
    [runnerId],
  );
}

type TargetRecord = RunnerAgentTargetRow & { rollback: number; requestedAt: number };

function targets(db: Database, runnerId: string): TargetRecord[] {
  return db
    .query<Omit<TargetRecord, "packages"> & { packages: string }, [string]>(
      `SELECT id,agent,version,integrity,native_version AS nativeVersion,packages,rollback,
       requested_at AS requestedAt FROM runner_agent_target WHERE runner_id=? ORDER BY agent`,
    )
    .all(runnerId)
    .map((row) => ({ ...row, packages: JSON.parse(row.packages) as CatalogPackage[] }));
}

/**
 * Why Paws no longer sends a target, or null. An update must still be eligible in the catalog
 * with the integrity it was chosen with; a rollback must not be to a version Paws refused.
 */
function blocked(db: Database, target: TargetRecord): string | null {
  const row = readAgentVersion(db, target.agent, target.version);
  if (target.rollback) {
    return row?.status === "refused"
      ? `Paws refused ${name(target.agent)} ${target.version}: ${row.reason ?? "its integrity changed."}`
      : null;
  }
  if (!row || row.status !== "eligible" || row.integrity !== target.integrity)
    return `Paws no longer offers ${name(target.agent)} ${target.version}${row?.reason ? `: ${row.reason}` : "."}`;
  return null;
}

/** The targets the heartbeat reply carries: each one the catalog still allows. */
export function runnerAgentTargets(db: Database, runnerId: string): RunnerAgentTargetRow[] {
  return targets(db, runnerId)
    .filter((target) => blocked(db, target) === null)
    .map(({ id, agent, version, integrity, nativeVersion, packages }) => ({
      id,
      agent,
      version,
      integrity,
      nativeVersion,
      packages,
    }));
}

export function listRunnerAgents(db: Database, runnerId: string): RunnerAgentView[] {
  const rows = db
    .query<
      {
        agent: string;
        version: string;
        status: ReportedStatus;
        error: string | null;
        sessions: number | null;
        targetId: string | null;
        reportedAt: number;
      },
      [string]
    >(
      `SELECT agent,version,status,error,sessions,target_id AS targetId,reported_at AS reportedAt
       FROM runner_agent WHERE runner_id=?`,
    )
    .all(runnerId);
  const views = new Map<string, RunnerAgentView>();
  const view = (agent: string) => {
    let entry = views.get(agent);
    if (!entry)
      views.set(
        agent,
        (entry = { agent, current: null, previous: null, pending: null, reportedAt: null }),
      );
    return entry;
  };
  for (const row of rows) {
    const entry = view(row.agent);
    entry.reportedAt = Math.max(entry.reportedAt ?? 0, row.reportedAt);
    if (row.status === "current") entry.current = row.version;
    if (row.status === "previous") entry.previous = row.version;
  }
  for (const target of targets(db, runnerId)) {
    const reported = rows.find(
      (row) =>
        row.agent === target.agent &&
        row.targetId === target.id &&
        (row.status === "installing" || row.status === "waiting" || row.status === "failed"),
    );
    const refusal = blocked(db, target);
    view(target.agent).pending = {
      version: target.version,
      rollback: target.rollback === 1,
      status: refusal ? "failed" : ((reported?.status as "installing") ?? "requested"),
      sessions: !refusal && reported?.status === "waiting" ? reported.sessions : null,
      error: refusal ?? (reported?.status === "failed" ? reported.error : null),
      requestedAt: target.requestedAt,
    };
  }
  return [...views.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

type Request = { workspaceId: string; userId: string; now: number; id: string };

function activeRunner(db: Database, runnerId: string, workspaceId: string): void {
  const row = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM runner WHERE id=? AND workspace_id=? AND revoked_at IS NULL AND status<>'revoked'`,
    )
    .get(runnerId, workspaceId);
  if (!row) throw new Error("Runner is unavailable.");
}

function reportedVersion(
  db: Database,
  runnerId: string,
  agent: string,
  status: "current" | "previous",
) {
  return (
    db
      .query<{ version: string }, [string, string, string]>(
        "SELECT version FROM runner_agent WHERE runner_id=? AND agent=? AND status=?",
      )
      .get(runnerId, agent, status)?.version ?? null
  );
}

function saveTarget(
  db: Database,
  runnerId: string,
  target: RunnerAgentTargetRow & { rollback: boolean },
  request: Omit<Request, "id">,
): void {
  db.run(
    `INSERT INTO runner_agent_target(runner_id,agent,id,version,integrity,native_version,packages,rollback,requested_by,requested_at)
     VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(runner_id,agent) DO UPDATE SET id=excluded.id,
       version=excluded.version,integrity=excluded.integrity,native_version=excluded.native_version,
       packages=excluded.packages,rollback=excluded.rollback,requested_by=excluded.requested_by,
       requested_at=excluded.requested_at`,
    [
      runnerId,
      target.agent,
      target.id,
      target.version,
      target.integrity,
      target.nativeVersion,
      JSON.stringify(target.packages),
      target.rollback ? 1 : 0,
      request.userId,
      request.now,
    ],
  );
  auditWorkspaceAccess(db, {
    workspaceId: request.workspaceId,
    userId: request.userId,
    action: target.rollback ? "runner.agent_rollback" : "runner.agent_update",
    subject: `${runnerId}:${target.agent}@${target.version}`,
    now: request.now,
  });
}

/** Ask a runner to run `version` of `agent`. Only an eligible catalog version can be chosen. */
export function requestRunnerAgentUpdate(
  db: Database,
  input: Request & {
    runnerId: string;
    agent: string;
    version: string;
    catalogPackages: CatalogPackages;
  },
): void {
  immediate(db, () => {
    activeRunner(db, input.runnerId, input.workspaceId);
    const current = reportedVersion(db, input.runnerId, input.agent, "current");
    if (current === null)
      throw new RunnerAgentUpdateError(
        `This runner does not report ${name(input.agent)}. Update the runner package first.`,
      );
    const row = readAgentVersion(db, input.agent, input.version);
    if (!row || row.status !== "eligible")
      throw new RunnerAgentUpdateError(
        `${name(input.agent)} ${input.version} is not an eligible version${row?.reason ? `: ${row.reason}` : "."}`,
      );
    if (current === input.version)
      throw new RunnerAgentUpdateError(
        `This runner already runs ${name(input.agent)} ${input.version}.`,
      );
    saveTarget(
      db,
      input.runnerId,
      {
        id: input.id,
        agent: input.agent,
        version: input.version,
        integrity: row.integrity,
        nativeVersion: row.nativeVersion,
        packages: input.catalogPackages(input.agent, row.nativeVersion),
        rollback: false,
      },
      input,
    );
  });
}

/** Ask a runner to switch `agent` back to the version it ran before. */
export function requestRunnerAgentRollback(
  db: Database,
  input: Request & { runnerId: string; agent: string },
): string {
  return immediate(db, () => {
    activeRunner(db, input.runnerId, input.workspaceId);
    const previous = reportedVersion(db, input.runnerId, input.agent, "previous");
    if (previous === null)
      throw new RunnerAgentUpdateError(
        `This runner has no earlier ${name(input.agent)} version to roll back to.`,
      );
    const row = readAgentVersion(db, input.agent, previous);
    if (row?.status === "refused")
      throw new RunnerAgentUpdateError(
        `Paws refused ${name(input.agent)} ${previous}, so it cannot be rolled back to: ${row.reason ?? "its integrity changed."}`,
      );
    saveTarget(
      db,
      input.runnerId,
      {
        id: input.id,
        agent: input.agent,
        version: previous,
        integrity: null,
        nativeVersion: null,
        packages: [],
        rollback: true,
      },
      input,
    );
    return previous;
  });
}

/**
 * Ask every active runner in the workspace to run the newest eligible version of each agent it
 * reports. Returns how many agents were asked to update.
 */
export function requestAllRunnerAgentUpdates(
  db: Database,
  input: Omit<Request, "id"> & { id: () => string; catalogPackages: CatalogPackages },
): number {
  return immediate(db, () => {
    const offered = new Map(
      agentCatalogSummary(db)
        .filter((entry) => entry.offered !== null)
        .map((entry) => [entry.agent, entry.offered!] as const),
    );
    const rows = db
      .query<{ runnerId: string; agent: string; version: string }, [string]>(
        `SELECT a.runner_id AS runnerId,a.agent,a.version FROM runner_agent a JOIN runner r ON r.id=a.runner_id
         WHERE r.workspace_id=? AND r.revoked_at IS NULL AND r.status<>'revoked' AND a.status='current'
         ORDER BY a.runner_id,a.agent`,
      )
      .all(input.workspaceId);
    let count = 0;
    for (const row of rows) {
      const version = offered.get(row.agent);
      // Only forward: a runner already on a newer version (one still inside its 48 hours, say)
      // is never moved back to the catalog's newest eligible one.
      if (!version || Bun.semver.order(version, row.version) <= 0) continue;
      const pending = db
        .query<{ id: string; version: string; rollback: number }, [string, string]>(
          "SELECT id,version,rollback FROM runner_agent_target WHERE runner_id=? AND agent=?",
        )
        .get(row.runnerId, row.agent);
      // A request on its way is left alone; a failed one is asked again under a new id, which
      // the installer treats as a new request.
      const failed =
        pending !== null &&
        db
          .query<{ one: number }, [string, string, string]>(
            "SELECT 1 AS one FROM runner_agent WHERE runner_id=? AND agent=? AND status='failed' AND target_id=?",
          )
          .get(row.runnerId, row.agent, pending.id) !== null;
      if (pending?.version === version && !pending.rollback && !failed) continue;
      const catalog = readAgentVersion(db, row.agent, version)!;
      saveTarget(
        db,
        row.runnerId,
        {
          id: input.id(),
          agent: row.agent,
          version,
          integrity: catalog.integrity,
          nativeVersion: catalog.nativeVersion,
          packages: input.catalogPackages(row.agent, catalog.nativeVersion),
          rollback: false,
        },
        input,
      );
      count++;
    }
    return count;
  });
}
