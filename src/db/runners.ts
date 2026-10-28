import { workspaceMemberUsableSql } from "./workspace";
import type { Database } from "bun:sqlite";
import { runnerLeaseCutoff } from "./runner-lease";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";
import type { RunnerSessionMove } from "./runner-session-moves";
import { listSkills, runnerSkillStates, type RunnerSkillView } from "./skills";
import { listRunnerRuntimes, type RunnerRuntimeStatus } from "./runner-runtimes";
import { listRunnerAgents, type RunnerAgentView } from "./runner-agents";

export type RunnerRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  status: "active" | "paused" | "draining" | "revoked";
  fence: number;
};
export type StoredRunnerCertificate = {
  fingerprint: string;
  serial: string;
  pem: string;
  notBefore: number;
  notAfter: number;
};

export function getRunner(db: Database, id: string): RunnerRecord | null {
  return db
    .query<RunnerRecord, [string]>(
      `SELECT id,workspace_id AS workspaceId,owner_user_id AS ownerUserId,name,status,fence
    FROM runner WHERE id=?`,
    )
    .get(id);
}

export function listRunners(db: Database, workspaceId: string): RunnerRecord[] {
  return db
    .query<RunnerRecord, [string]>(
      `SELECT id,workspace_id AS workspaceId,owner_user_id AS ownerUserId,name,status,fence
    FROM runner WHERE workspace_id=? ORDER BY created_at,id`,
    )
    .all(workspaceId);
}

export type RunnerHostSample = {
  cpuPercent?: number;
  cpuCount?: number;
  memoryTotalBytes?: number;
  memoryAvailableBytes?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  osId?: string;
  osVersion?: string;
  runnerVersion?: string;
  miseVersion?: string;
  /** Absent when the runner does not report them. */
  strayProcesses?: RunnerStrayProcess[];
};

/** A process of the runner user outside the runner's process tree, as last reported. */
export type RunnerStrayProcess = {
  pid: number;
  name: string;
  ageSeconds: number;
  cpuPercent: number;
};

export type RunnerOverview = RunnerRecord & {
  hasRunWork: boolean;
  /** The owner's display name, so the Runners page can say whose host it is. */
  ownerName: string | null;
  metrics: {
    cpuPercent: number | null;
    cpuCount: number | null;
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    /** Null when the runner release does not report them. */
    strayProcesses: RunnerStrayProcess[] | null;
    reportedAt: number;
  } | null;
  os: { id: string | null; version: string | null } | null;
  version: string | null;
  idle: boolean;
  slots: { used: number; total: number };
  /** Desired is set in Paws; applied and ceiling are what the runner last reported. */
  concurrency: { desired: number | null; applied: number; ceiling: number | null } | null;
  /** Sessions holding a live work lease on this runner, oldest first. */
  running: RunnerSession[];
  skills: RunnerSkillView[];
  /** Runtimes mise installed for tasks on this runner, and failed installs, as last reported. */
  runtimes: RunnerRuntimeStatus[];
  /** Coding agent versions as last reported, and the version asked for from the Runners page. */
  codingAgents: RunnerAgentView[];
};

export type RunnerSessionPhase = "working" | "closeout" | "fixing" | "merging";
export type RunnerSession = {
  runId: string;
  identifier: string;
  title: string;
  phase: RunnerSessionPhase;
  startedAt: number;
  /** The runner can hand it over now: its work lease is live, not only its Closeout slot. */
  movable: boolean;
  /** Its move off this runner; null once it lands on another runner. */
  move: RunnerSessionMove | null;
};

function listRunnerSessions(
  db: Database,
  workspaceId: string,
  now: number,
): Map<string, RunnerSession[]> {
  const rows = db
    .query<
      Omit<RunnerSession, "movable" | "move"> & {
        runnerId: string;
        movable: number;
        moveStatus: RunnerSessionMove["status"] | null;
        moveReason: string | null;
      },
      [number, number, string]
    >(
      `SELECT w.runner_id AS runnerId,w.run_id AS runId,i.linear_identifier AS identifier,i.title,
    CASE
      WHEN i.state='verifying' OR json_extract(i.checkpoint,'$.phase')='verifying' THEN 'closeout'
      WHEN i.state='merge_queue' OR json_extract(i.checkpoint,'$.phase')='merge_queue' THEN 'merging'
      WHEN (SELECT p.decision FROM closeout_progress p WHERE p.item_id=i.id
        ORDER BY p.updated_at DESC,p.rowid DESC LIMIT 1)='rejected' THEN 'fixing'
      ELSE 'working'
    END AS phase,
    r.created_at AS startedAt,(w.ended_at IS NULL AND w.lease_until>?) AS movable,
    m.status AS moveStatus,m.reason AS moveReason
    FROM runner_work w JOIN run r ON r.id=w.run_id JOIN work_item i ON i.id=r.item_id
    LEFT JOIN runner_session_move m ON m.run_id=w.run_id AND m.runner_id=w.runner_id
    WHERE ((w.ended_at IS NULL AND w.lease_until>?) OR r.status IN ('active','provisioning'))
    AND w.workspace_id=?
    ORDER BY r.created_at,w.run_id`,
    )
    .all(runnerLeaseCutoff(now), runnerLeaseCutoff(now), workspaceId);
  const sessions = new Map<string, RunnerSession[]>();
  for (const { runnerId, movable, moveStatus, moveReason, ...session } of rows)
    sessions.set(runnerId, [
      ...(sessions.get(runnerId) ?? []),
      {
        ...session,
        movable: movable === 1,
        move: moveStatus ? { status: moveStatus, reason: moveReason } : null,
      },
    ]);
  return sessions;
}

/** Keeps only the latest host sample per runner. */
export function recordRunnerHostStatus(
  db: Database,
  runnerId: string,
  sample: RunnerHostSample,
  reportedAt: number,
): void {
  db.run(
    `INSERT INTO runner_host_status(runner_id,cpu_percent,cpu_count,memory_total_bytes,memory_available_bytes,
    load_1,load_5,load_15,disk_total_bytes,disk_free_bytes,os_id,os_version,runner_version,mise_version,
    stray_processes,reported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(runner_id) DO UPDATE SET cpu_percent=excluded.cpu_percent,cpu_count=excluded.cpu_count,
    memory_total_bytes=excluded.memory_total_bytes,memory_available_bytes=excluded.memory_available_bytes,
    load_1=excluded.load_1,load_5=excluded.load_5,load_15=excluded.load_15,
    disk_total_bytes=excluded.disk_total_bytes,disk_free_bytes=excluded.disk_free_bytes,
    os_id=excluded.os_id,os_version=excluded.os_version,runner_version=excluded.runner_version,
    mise_version=excluded.mise_version,stray_processes=excluded.stray_processes,reported_at=excluded.reported_at`,
    [
      runnerId,
      sample.cpuPercent ?? null,
      sample.cpuCount ?? null,
      sample.memoryTotalBytes ?? null,
      sample.memoryAvailableBytes ?? null,
      sample.load1 ?? null,
      sample.load5 ?? null,
      sample.load15 ?? null,
      sample.diskTotalBytes ?? null,
      sample.diskFreeBytes ?? null,
      sample.osId ?? null,
      sample.osVersion ?? null,
      sample.runnerVersion ?? null,
      sample.miseVersion ?? null,
      sample.strayProcesses ? JSON.stringify(sample.strayProcesses) : null,
      reportedAt,
    ],
  );
}

export type RunnerAgentLimit = { window: string; usedPercent: number; resetsAt: number | null };

export function recordRunnerAgentUsage(
  db: Database,
  usage: {
    runnerId: string;
    agent: string;
    limits: RunnerAgentLimit[];
    observedAt: number;
  },
): void {
  db.run(
    `INSERT INTO runner_agent_usage(runner_id,agent,limits_json,observed_at) VALUES(?,?,?,?)
    ON CONFLICT(runner_id,agent) DO UPDATE SET limits_json=excluded.limits_json,
    observed_at=excluded.observed_at WHERE excluded.observed_at>=runner_agent_usage.observed_at`,
    [usage.runnerId, usage.agent, JSON.stringify(usage.limits), usage.observedAt],
  );
}

export function runnerAgentUsage(
  db: Database,
  runnerId: string,
  agent: string,
): { limits: RunnerAgentLimit[]; observedAt: number } | null {
  const row = db
    .query<{ limits: string; observedAt: number }, [string, string]>(
      "SELECT limits_json AS limits,observed_at AS observedAt FROM runner_agent_usage WHERE runner_id=? AND agent=?",
    )
    .get(runnerId, agent);
  return row
    ? { limits: JSON.parse(row.limits) as RunnerAgentLimit[], observedAt: row.observedAt }
    : null;
}

/** Runners with their latest host sample. Idle means no open work and no pending command. */
export function listRunnerOverview(
  db: Database,
  workspaceId: string,
  now: number,
): RunnerOverview[] {
  type Row = RunnerRecord & {
    cpuPercent: number | null;
    cpuCount: number | null;
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    osId: string | null;
    osVersion: string | null;
    runnerVersion: string | null;
    strayProcesses: string | null;
    reportedAt: number | null;
    busy: number;
    used: number;
    total: number;
    applied: number | null;
    ceiling: number | null;
    desired: number | null;
    ownerName: string | null;
    hasRunWork: number;
  };
  const sessions = listRunnerSessions(db, workspaceId, now);
  const pins = listSkills(db);
  return db
    .query<Row, [number, number, number, string]>(
      `SELECT r.id,r.workspace_id AS workspaceId,r.owner_user_id AS ownerUserId,r.name,r.status,r.fence,
    (EXISTS(SELECT 1 FROM runner_work w WHERE w.runner_id=r.id)
     OR EXISTS(SELECT 1 FROM runner_command c WHERE c.runner_id=r.id AND c.kind IN ('run','review','check','task'))
     OR EXISTS(SELECT 1 FROM runner_helper x WHERE x.runner_id=r.id)) AS hasRunWork,
    h.cpu_percent AS cpuPercent,h.cpu_count AS cpuCount,h.memory_total_bytes AS memoryTotalBytes,
    h.memory_available_bytes AS memoryAvailableBytes,h.load_1 AS load1,h.load_5 AS load5,
    h.load_15 AS load15,h.disk_total_bytes AS diskTotalBytes,h.disk_free_bytes AS diskFreeBytes,
    h.os_id AS osId,h.os_version AS osVersion,h.runner_version AS runnerVersion,
    h.stray_processes AS strayProcesses,h.reported_at AS reportedAt,
    (EXISTS(SELECT 1 FROM runner_work w WHERE w.runner_id=r.id AND w.ended_at IS NULL)
     OR EXISTS(SELECT 1 FROM runner_command c WHERE c.runner_id=r.id
       AND c.acknowledged_at IS NULL AND c.expires_at>?)) AS busy,
    (SELECT count(*) FROM runner_work w JOIN run u ON u.id=w.run_id WHERE w.runner_id=r.id
     AND ((w.ended_at IS NULL AND w.lease_until>?) OR u.status IN ('active','provisioning'))) +
    (SELECT count(*) FROM runner_helper x WHERE x.runner_id=r.id AND x.ended_at IS NULL AND x.expires_at>?) AS used,
    COALESCE(MIN(c.capacity,COALESCE(c.desired,16)),1) AS total,
    c.capacity AS applied,c.ceiling,c.desired,o.name AS ownerName
    FROM runner r LEFT JOIN runner_host_status h ON h.runner_id=r.id
    LEFT JOIN runner_capacity c ON c.runner_id=r.id
    LEFT JOIN workspace_user o ON o.id=r.owner_user_id
    WHERE r.workspace_id=? ORDER BY r.created_at,r.id`,
    )
    .all(now, runnerLeaseCutoff(now), now, workspaceId)
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerName,
      hasRunWork: row.hasRunWork === 1,
      name: row.name,
      status: row.status,
      fence: row.fence,
      metrics:
        row.reportedAt === null
          ? null
          : {
              cpuPercent: row.cpuPercent,
              cpuCount: row.cpuCount,
              memoryTotalBytes: row.memoryTotalBytes,
              memoryAvailableBytes: row.memoryAvailableBytes,
              load1: row.load1,
              load5: row.load5,
              load15: row.load15,
              diskTotalBytes: row.diskTotalBytes,
              diskFreeBytes: row.diskFreeBytes,
              strayProcesses:
                row.strayProcesses === null
                  ? null
                  : (JSON.parse(row.strayProcesses) as RunnerStrayProcess[]),
              reportedAt: row.reportedAt,
            },
      os:
        row.osId === null && row.osVersion === null
          ? null
          : { id: row.osId, version: row.osVersion },
      version: row.runnerVersion,
      idle: row.busy === 0,
      slots: { used: row.used, total: row.total },
      concurrency:
        row.applied === null
          ? null
          : { desired: row.desired, applied: row.applied, ceiling: row.ceiling },
      running: sessions.get(row.id) ?? [],
      skills: runnerSkillStates(db, row.id, pins),
      runtimes: listRunnerRuntimes(db, row.id),
      codingAgents: listRunnerAgents(db, row.id),
    }));
}

export function runnerForCertificate(
  db: Database,
  fingerprint: string,
  now: number,
): RunnerRecord | null {
  const row = db
    .query<{ id: string }, [string, number, number]>(
      `SELECT r.id FROM runner_certificate c JOIN runner r ON r.id=c.runner_id
    JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
    WHERE c.fingerprint=? AND c.revoked_at IS NULL AND c.not_before<=?
    AND c.accepted_until>? AND r.revoked_at IS NULL AND r.status<>'revoked' AND ${workspaceMemberUsableSql("m")}`,
    )
    .get(fingerprint, now, now);
  return row ? getRunner(db, row.id) : null;
}

function insertCertificate(
  db: Database,
  runnerId: string,
  certificate: StoredRunnerCertificate,
): void {
  db.run(
    `INSERT INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until)
    VALUES(?,?,?,?,?,?,?)`,
    [
      certificate.fingerprint,
      certificate.serial,
      runnerId,
      certificate.pem,
      certificate.notBefore,
      certificate.notAfter,
      certificate.notAfter,
    ],
  );
}

export function createRunnerEnrollment(
  db: Database,
  input: {
    id: string;
    tokenHash: string;
    workspaceId: string;
    userId: string;
    name: string;
    expiresAt: number;
    now: number;
  },
): void {
  immediate(db, () => {
    db.run("DELETE FROM runner_enrollment WHERE used_at IS NULL AND expires_at<=?", [input.now]);
    const pending = db
      .query<{ count: number }, [string, number]>(
        "SELECT count(*) AS count FROM runner_enrollment WHERE workspace_id=? AND used_at IS NULL AND expires_at>?",
      )
      .get(input.workspaceId, input.now)!.count;
    if (pending >= 100) throw new Error("Too many runner enrollments. Try again shortly.");
    db.run(
      `INSERT INTO runner_enrollment(id,token_hash,workspace_id,user_id,name,expires_at)
      VALUES(?,?,?,?,?,?)`,
      [input.id, input.tokenHash, input.workspaceId, input.userId, input.name, input.expiresAt],
    );
  });
}

export type RunnerEnrollment = {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  expiresAt: number;
};

/**
 * The unused, unexpired enrollment for `tokenHash` whose member is still active, or null.
 */
export function findRunnerEnrollment(
  db: Database,
  tokenHash: string,
  now: number,
): RunnerEnrollment | null {
  return db
    .query<RunnerEnrollment, [string, number]>(
      `SELECT e.id,e.workspace_id AS workspaceId,e.user_id AS userId,e.name,e.expires_at AS expiresAt
      FROM runner_enrollment e JOIN workspace_member m
      ON m.workspace_id=e.workspace_id AND m.user_id=e.user_id
      WHERE e.token_hash=? AND e.used_at IS NULL AND e.runner_id IS NULL AND e.expires_at>?
      AND ${workspaceMemberUsableSql("m")}`,
    )
    .get(tokenHash, now);
}

/**
 * Use an enrollment: create the runner owned by the enrollment's member, store its certificate,
 * mark the token used and audit `runner.paired` with that member as actor. Throws, writing
 * nothing, when the token is used, expired or its member may no longer own a runner.
 */
export function enrollRunner(
  db: Database,
  input: {
    tokenHash: string;
    runnerId: string;
    name: string;
    certificate: StoredRunnerCertificate;
    now: number;
  },
): RunnerEnrollment {
  return immediate(db, () => {
    const enrollment = findRunnerEnrollment(db, input.tokenHash, input.now);
    if (!enrollment) throw new Error("Runner enrollment is invalid or expired.");
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'paused',?)",
      [input.runnerId, enrollment.workspaceId, enrollment.userId, input.name, input.now],
    );
    insertCertificate(db, input.runnerId, input.certificate);
    const used = db.run(
      "UPDATE runner_enrollment SET used_at=?,runner_id=? WHERE id=? AND used_at IS NULL",
      [input.now, input.runnerId, enrollment.id],
    ).changes;
    if (used !== 1) throw new Error("Runner enrollment is invalid or expired.");
    auditWorkspaceAccess(db, {
      workspaceId: enrollment.workspaceId,
      userId: enrollment.userId,
      action: "runner.paired",
      subject: input.runnerId,
      now: input.now,
    });
    return enrollment;
  });
}

export function isCurrentRunnerCertificate(db: Database, fingerprint: string): boolean {
  return (
    db
      .query<{ current: number }, [string]>(
        "SELECT rowid=(SELECT MAX(latest.rowid) FROM runner_certificate latest WHERE latest.runner_id=runner_certificate.runner_id) AS current FROM runner_certificate WHERE fingerprint=?",
      )
      .get(fingerprint)?.current === 1
  );
}

export function renewRunnerCertificate(
  db: Database,
  input: {
    previousFingerprint: string;
    certificate: StoredRunnerCertificate;
    now: number;
  },
): RunnerRecord {
  return immediate(db, () => {
    const runner = runnerForCertificate(db, input.previousFingerprint, input.now);
    if (!runner) throw new Error("Runner identity is revoked or expired.");
    if (!isCurrentRunnerCertificate(db, input.previousFingerprint))
      throw new Error("Runner certificate has been superseded.");
    db.run(
      "UPDATE runner_certificate SET accepted_until=MIN(accepted_until,?) WHERE fingerprint=?",
      [input.now + 5 * 60_000, input.previousFingerprint],
    );
    insertCertificate(db, runner.id, input.certificate);
    auditWorkspaceAccess(db, {
      workspaceId: runner.workspaceId,
      userId: runner.ownerUserId,
      action: "runner.certificate.renewed",
      subject: runner.id,
      now: input.now,
    });
    return runner;
  });
}

export function updateRunnerStatus(
  db: Database,
  input: {
    runnerId: string;
    workspaceId: string;
    userId: string;
    status: RunnerRecord["status"];
    now: number;
  },
): string[] {
  return immediate(db, () => {
    const changed = db.run(
      `UPDATE runner SET status=?,fence=fence+CASE WHEN ?='revoked' THEN 1 ELSE 0 END,
      revoked_at=CASE WHEN ?='revoked' THEN ? ELSE NULL END
      WHERE id=? AND workspace_id=? AND revoked_at IS NULL`,
      [input.status, input.status, input.status, input.now, input.runnerId, input.workspaceId],
    ).changes;
    if (changed !== 1) throw new Error("Runner is unavailable.");
    const fingerprints = db
      .query<{ fingerprint: string }, [string]>(
        "SELECT fingerprint FROM runner_certificate WHERE runner_id=? AND revoked_at IS NULL",
      )
      .all(input.runnerId)
      .map((row) => row.fingerprint);
    if (input.status === "revoked") {
      db.run("UPDATE runner_certificate SET revoked_at=? WHERE runner_id=?", [
        input.now,
        input.runnerId,
      ]);
      db.run("UPDATE member_vm SET runner_id=NULL,updated_at=? WHERE runner_id=?", [
        input.now,
        input.runnerId,
      ]);
    }
    auditWorkspaceAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: `runner.${input.status}`,
      subject: input.runnerId,
      now: input.now,
    });
    return input.status === "revoked" ? fingerprints : [];
  });
}

export function runRunnerName(db: Database, runId: string): string | null {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT r.name FROM runner_work w JOIN runner r ON r.id=w.runner_id WHERE w.run_id=?",
      )
      .get(runId)?.name ?? null
  );
}

export type RunnerAvailability = {
  id: string;
  name: string;
  status: RunnerRecord["status"];
  revoked: boolean;
  lastSeenAt: number | null;
};

/** The runner that holds a run's remote work, as last reported. */
export function runRunnerAvailability(db: Database, runId: string): RunnerAvailability | null {
  const row = db
    .query<Omit<RunnerAvailability, "revoked"> & { revoked: number }, [string]>(
      `SELECT r.id,r.name,r.status,r.revoked_at IS NOT NULL AS revoked,r.last_seen_at AS lastSeenAt
       FROM runner_work w JOIN runner r ON r.id=w.runner_id WHERE w.run_id=?`,
    )
    .get(runId);
  return row ? { ...row, revoked: row.revoked === 1 } : null;
}
