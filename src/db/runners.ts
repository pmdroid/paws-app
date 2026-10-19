import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";

export type RunnerRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  status: "active" | "paused" | "draining" | "revoked";
  fence: number;
};
export type RunnerPairing = {
  id: string;
  csr: string;
  name: string;
  requestFingerprint: string;
  expiresAt: number;
  runnerId: string | null;
  certificateFingerprint: string | null;
};
export type StoredRunnerCertificate = {
  fingerprint: string;
  serial: string;
  pem: string;
  notBefore: number;
  notAfter: number;
};

export function createRunnerPairing(
  db: Database,
  input: RunnerPairing & { claimHash: string; codeHash: string },
): void {
  db.run(
    `INSERT INTO runner_pairing(id,claim_hash,code_hash,csr,name,request_fingerprint,expires_at)
    VALUES(?,?,?,?,?,?,?)`,
    [
      input.id,
      input.claimHash,
      input.codeHash,
      input.csr,
      input.name,
      input.requestFingerprint,
      input.expiresAt,
    ],
  );
}

export function findRunnerPairing(
  db: Database,
  input: { codeHash: string } | { id: string; claimHash: string },
): RunnerPairing | null {
  const columns = `SELECT id,csr,name,request_fingerprint AS requestFingerprint,expires_at AS expiresAt,
    runner_id AS runnerId,certificate_fingerprint AS certificateFingerprint FROM runner_pairing`;
  return "codeHash" in input
    ? db.query<RunnerPairing, [string]>(`${columns} WHERE code_hash=?`).get(input.codeHash)
    : db
        .query<RunnerPairing, [string, string]>(`${columns} WHERE id=? AND claim_hash=?`)
        .get(input.id, input.claimHash);
}

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
};

export type RunnerOverview = RunnerRecord & {
  metrics: {
    cpuPercent: number | null;
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    reportedAt: number;
  } | null;
  os: { id: string | null; version: string | null } | null;
  version: string | null;
  idle: boolean;
  slots: { used: number; total: number };
};

/** Keeps only the latest host sample per runner. */
export function recordRunnerHostStatus(
  db: Database,
  runnerId: string,
  sample: RunnerHostSample,
  reportedAt: number,
): void {
  db.run(
    `INSERT INTO runner_host_status(runner_id,cpu_percent,memory_total_bytes,memory_available_bytes,
    load_1,load_5,load_15,disk_total_bytes,disk_free_bytes,os_id,os_version,runner_version,reported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(runner_id) DO UPDATE SET cpu_percent=excluded.cpu_percent,
    memory_total_bytes=excluded.memory_total_bytes,memory_available_bytes=excluded.memory_available_bytes,
    load_1=excluded.load_1,load_5=excluded.load_5,load_15=excluded.load_15,
    disk_total_bytes=excluded.disk_total_bytes,disk_free_bytes=excluded.disk_free_bytes,
    os_id=excluded.os_id,os_version=excluded.os_version,runner_version=excluded.runner_version,
    reported_at=excluded.reported_at`,
    [
      runnerId,
      sample.cpuPercent ?? null,
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
      reportedAt,
    ],
  );
}

/** Runners with their latest host sample. Idle means no open work and no pending command. */
export function listRunnerOverview(
  db: Database,
  workspaceId: string,
  now: number,
): RunnerOverview[] {
  type Row = RunnerRecord & {
    cpuPercent: number | null;
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
    reportedAt: number | null;
    busy: number;
    used: number;
    total: number;
  };
  return db
    .query<Row, [number, number, number, string]>(
      `SELECT r.id,r.workspace_id AS workspaceId,r.owner_user_id AS ownerUserId,r.name,r.status,r.fence,
    h.cpu_percent AS cpuPercent,h.memory_total_bytes AS memoryTotalBytes,
    h.memory_available_bytes AS memoryAvailableBytes,h.load_1 AS load1,h.load_5 AS load5,
    h.load_15 AS load15,h.disk_total_bytes AS diskTotalBytes,h.disk_free_bytes AS diskFreeBytes,
    h.os_id AS osId,h.os_version AS osVersion,h.runner_version AS runnerVersion,
    h.reported_at AS reportedAt,
    (EXISTS(SELECT 1 FROM runner_work w WHERE w.runner_id=r.id AND w.ended_at IS NULL)
     OR EXISTS(SELECT 1 FROM runner_command c WHERE c.runner_id=r.id
       AND c.acknowledged_at IS NULL AND c.expires_at>?)) AS busy,
    (SELECT count(*) FROM runner_work w WHERE w.runner_id=r.id AND w.ended_at IS NULL AND w.lease_until>?) +
    (SELECT count(*) FROM runner_helper x WHERE x.runner_id=r.id AND x.ended_at IS NULL AND x.expires_at>?) AS used,
    COALESCE((SELECT capacity FROM runner_capacity c WHERE c.runner_id=r.id),1) AS total
    FROM runner r LEFT JOIN runner_host_status h ON h.runner_id=r.id
    WHERE r.workspace_id=? ORDER BY r.created_at,r.id`,
    )
    .all(now, now, now, workspaceId)
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
      name: row.name,
      status: row.status,
      fence: row.fence,
      metrics:
        row.reportedAt === null
          ? null
          : {
              cpuPercent: row.cpuPercent,
              memoryTotalBytes: row.memoryTotalBytes,
              memoryAvailableBytes: row.memoryAvailableBytes,
              load1: row.load1,
              load5: row.load5,
              load15: row.load15,
              diskTotalBytes: row.diskTotalBytes,
              diskFreeBytes: row.diskFreeBytes,
              reportedAt: row.reportedAt,
            },
      os:
        row.osId === null && row.osVersion === null
          ? null
          : { id: row.osId, version: row.osVersion },
      version: row.runnerVersion,
      idle: row.busy === 0,
      slots: { used: row.used, total: row.total },
    }));
}

export function getRunnerCertificate(
  db: Database,
  fingerprint: string,
): StoredRunnerCertificate | null {
  return db
    .query<StoredRunnerCertificate, [string]>(
      `SELECT fingerprint,serial,pem,not_before AS notBefore,not_after AS notAfter
    FROM runner_certificate WHERE fingerprint=?`,
    )
    .get(fingerprint);
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
    AND c.accepted_until>? AND r.revoked_at IS NULL AND r.status<>'revoked' AND m.active=1`,
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

export function approveRunnerPairing(
  db: Database,
  input: {
    pairingId: string;
    runnerId: string;
    workspaceId: string;
    userId: string;
    certificate: StoredRunnerCertificate;
    now: number;
  },
): void {
  immediate(db, () => {
    const pairing = db
      .query<{ name: string }, [string, number]>(
        "SELECT name FROM runner_pairing WHERE id=? AND expires_at>? AND runner_id IS NULL",
      )
      .get(input.pairingId, input.now);
    if (!pairing) throw new Error("Runner pairing is invalid or expired.");
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
      [input.runnerId, input.workspaceId, input.userId, pairing.name, input.now],
    );
    insertCertificate(db, input.runnerId, input.certificate);
    db.run(
      "UPDATE runner_pairing SET approved_by=?,runner_id=?,certificate_fingerprint=? WHERE id=?",
      [input.userId, input.runnerId, input.certificate.fingerprint, input.pairingId],
    );
    auditWorkspaceAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: "runner.paired",
      subject: input.runnerId,
      now: input.now,
    });
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
    if (input.status === "revoked")
      db.run("UPDATE runner_certificate SET revoked_at=? WHERE runner_id=?", [
        input.now,
        input.runnerId,
      ]);
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

export function expireRunnerPairings(db: Database, now: number): void {
  immediate(db, () => {
    const abandoned = db
      .query<{ id: string; workspaceId: string }, [number]>(
        `SELECT r.id,r.workspace_id AS workspaceId FROM runner_pairing p JOIN runner r ON r.id=p.runner_id
      WHERE p.expires_at<=? AND p.claimed_at IS NULL AND r.revoked_at IS NULL`,
      )
      .all(now);
    for (const runner of abandoned) {
      db.run("UPDATE runner SET status='revoked',revoked_at=?,fence=fence+1 WHERE id=?", [
        now,
        runner.id,
      ]);
      db.run(
        "UPDATE runner_certificate SET revoked_at=? WHERE runner_id=? AND revoked_at IS NULL",
        [now, runner.id],
      );
      auditWorkspaceAccess(db, {
        workspaceId: runner.workspaceId,
        userId: null,
        action: "runner.pairing_expired",
        subject: runner.id,
        now,
      });
    }
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
