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
export type RunnerHostStatus = { [K in keyof RunnerHostSample]-?: RunnerHostSample[K] | null } & {
  reportedAt: number;
};
export type RunnerListing = RunnerRecord & {
  lastSeenAt: number | null;
  host: RunnerHostStatus | null;
  idle: boolean;
};

const hostColumns = [
  ["cpuPercent", "cpu_percent"],
  ["memoryTotalBytes", "memory_total_bytes"],
  ["memoryAvailableBytes", "memory_available_bytes"],
  ["load1", "load1"],
  ["load5", "load5"],
  ["load15", "load15"],
  ["diskTotalBytes", "disk_total_bytes"],
  ["diskFreeBytes", "disk_free_bytes"],
  ["osId", "os_id"],
  ["osVersion", "os_version"],
  ["runnerVersion", "runner_version"],
] as const satisfies readonly (readonly [keyof RunnerHostSample, string])[];

/** Keeps only the latest sample per runner. A field the runner left out is stored as null. */
export function upsertRunnerHostStatus(
  db: Database,
  runnerId: string,
  sample: RunnerHostSample,
  now: number,
) {
  const names = hostColumns.map(([, column]) => column);
  db.run(
    `INSERT INTO runner_host_status (runner_id,${names.join(",")},reported_at)
    VALUES (?,${names.map(() => "?").join(",")},?)
    ON CONFLICT(runner_id) DO UPDATE SET ${[...names, "reported_at"].map((name) => `${name}=excluded.${name}`).join(",")}`,
    [runnerId, ...hostColumns.map(([key]) => sample[key] ?? null), now],
  );
}

/** Runners with their latest host sample and whether they have no open work or pending commands. */
export function listRunnerStatus(db: Database, workspaceId: string, now: number): RunnerListing[] {
  type Row = RunnerRecord & { lastSeenAt: number | null; idle: number; reportedAt: number | null };
  const rows = db
    .query<Row & Record<string, unknown>, [number, string]>(
      `SELECT r.id,r.workspace_id AS workspaceId,r.owner_user_id AS ownerUserId,r.name,r.status,r.fence,
      r.last_seen_at AS lastSeenAt,
      ${hostColumns.map(([key, column]) => `h.${column} AS ${key}`).join(",")},h.reported_at AS reportedAt,
      NOT EXISTS (SELECT 1 FROM runner_work w WHERE w.runner_id=r.id AND w.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM runner_helper p WHERE p.runner_id=r.id AND p.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM runner_command c WHERE c.runner_id=r.id
        AND c.acknowledged_at IS NULL AND c.expires_at>?) AS idle
    FROM runner r LEFT JOIN runner_host_status h ON h.runner_id=r.id
    WHERE r.workspace_id=? ORDER BY r.created_at,r.id`,
    )
    .all(now, workspaceId);
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    status: row.status,
    fence: row.fence,
    lastSeenAt: row.lastSeenAt,
    idle: row.idle === 1,
    host:
      row.reportedAt === null
        ? null
        : ({
            ...Object.fromEntries(hostColumns.map(([key]) => [key, row[key] ?? null])),
            reportedAt: row.reportedAt,
          } as RunnerHostStatus),
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
