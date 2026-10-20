import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { OnboardingAdmission } from "./onboarding-intake";
import { immediate } from "./tx";

export type MemberVmStep = "create" | "install" | "pair" | "health" | "ready";
export type MemberVmState = "pending" | "running" | "failed" | "ready";
export type MemberVmCreateOutcome = "none" | "unknown" | "created";

export type MemberVmRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  providerName: string;
  run: number;
  revision: number;
  step: MemberVmStep;
  state: MemberVmState;
  failure: string | null;
  createOutcome: MemberVmCreateOutcome;
  createRun: number | null;
  vm: { name: string; status?: string } | null;
  requestFingerprint: string | null;
  runnerId: string | null;
  stepStartedAt: number | null;
  runnerStarted: boolean;
  repositories: string[];
  policyRevision: number;
  policyAppliedRevision: number;
  policyFence: number;
  policyAppliedFence: number;
  sessionId: string | null;
  generation: number | null;
  originSessionId: string;
  originGeneration: number;
  createdAt: number;
  updatedAt: number;
};

export type MemberVmChanges = Partial<
  Pick<
    MemberVmRecord,
    | "run"
    | "step"
    | "state"
    | "failure"
    | "createOutcome"
    | "createRun"
    | "vm"
    | "requestFingerprint"
    | "runnerId"
    | "stepStartedAt"
    | "runnerStarted"
    | "repositories"
    | "policyRevision"
    | "policyAppliedRevision"
    | "policyFence"
    | "policyAppliedFence"
    | "sessionId"
    | "generation"
  >
>;

const COLUMNS: Record<keyof MemberVmChanges, string> = {
  run: "run",
  step: "step",
  state: "state",
  failure: "failure",
  createOutcome: "create_outcome",
  createRun: "create_run",
  vm: "vm",
  requestFingerprint: "request_fingerprint",
  runnerId: "runner_id",
  stepStartedAt: "step_started_at",
  runnerStarted: "runner_started",
  repositories: "repositories",
  policyRevision: "policy_revision",
  policyAppliedRevision: "policy_applied_revision",
  policyFence: "policy_fence",
  policyAppliedFence: "policy_applied_fence",
  sessionId: "session_id",
  generation: "generation",
};

const SELECT = `SELECT id,workspace_id AS workspaceId,user_id AS userId,provider_name AS providerName,run,revision,step,state,
failure,create_outcome AS createOutcome,create_run AS createRun,vm,request_fingerprint AS requestFingerprint,
runner_id AS runnerId,step_started_at AS stepStartedAt,runner_started AS runnerStarted,repositories,policy_revision AS policyRevision,policy_applied_revision AS policyAppliedRevision,policy_fence AS policyFence,policy_applied_fence AS policyAppliedFence,session_id AS sessionId,generation,
origin_session_id AS originSessionId,origin_generation AS originGeneration,created_at AS createdAt,updated_at AS updatedAt FROM member_vm`;

type Row = Omit<MemberVmRecord, "vm" | "runnerStarted" | "repositories"> & {
  vm: string | null;
  runnerStarted: number;
  repositories: string;
};

function record(row: Row | null): MemberVmRecord | null {
  return (
    row && {
      ...row,
      vm: row.vm === null ? null : JSON.parse(row.vm),
      runnerStarted: row.runnerStarted === 1,
      repositories: JSON.parse(row.repositories),
    }
  );
}

function column(key: keyof MemberVmChanges, value: unknown): string | number | null {
  if (key === "runnerStarted") return value ? 1 : 0;
  if (key === "repositories" || (key === "vm" && value !== null)) return JSON.stringify(value);
  return value as string | number | null;
}

export function readMemberVm(db: Database, workspaceId: string, userId: string) {
  return record(
    db
      .query<Row, [string, string]>(`${SELECT} WHERE workspace_id=? AND user_id=?`)
      .get(workspaceId, userId),
  );
}

export function readMemberVmById(db: Database, id: string) {
  return record(db.query<Row, [string]>(`${SELECT} WHERE id=?`).get(id));
}

export function reserveMemberVm(
  db: Database,
  input: {
    id: string;
    workspaceId: string;
    userId: string;
    providerName: string;
    sessionId: string;
    generation: number;
    now: number;
  },
): MemberVmRecord {
  db.run(
    `INSERT INTO member_vm(id,workspace_id,user_id,provider_name,step,state,session_id,generation,
    origin_session_id,origin_generation,created_at,updated_at)
    VALUES(?,?,?,?,'create','pending',?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING`,
    [
      input.id,
      input.workspaceId,
      input.userId,
      input.providerName,
      input.sessionId,
      input.generation,
      input.sessionId,
      input.generation,
      input.now,
      input.now,
    ],
  );
  return readMemberVm(db, input.workspaceId, input.userId)!;
}

export function updateMemberVm(
  db: Database,
  id: string,
  run: number,
  changes: MemberVmChanges,
  now: number,
): boolean {
  const entries = Object.entries(changes) as [keyof MemberVmChanges, unknown][];
  const assignments = entries.map(([key]) => `${COLUMNS[key]}=?`);
  const values = entries.map(([key, value]) => column(key, value));
  return (
    db.run(
      `UPDATE member_vm SET ${[...assignments, "revision=revision+1", "updated_at=?"].join(",")} WHERE id=? AND run=?`,
      [...values, now, id, run],
    ).changes > 0
  );
}

export function healthyOnboardingRunners(
  db: Database,
  scope: { workspaceId: string; userId: string },
  since: number,
  now: number,
) {
  return db
    .query<{ id: string; name: string; fence: number }, [string, string, number, number, number]>(
      `SELECT r.id,r.name,r.fence FROM runner r
      JOIN runner_certificate c ON c.runner_id=r.id
      WHERE r.workspace_id=? AND r.owner_user_id=? AND r.status='active' AND r.revoked_at IS NULL
      AND r.last_seen_at>? AND c.rowid=(SELECT MAX(latest.rowid) FROM runner_certificate latest WHERE latest.runner_id=r.id)
      AND c.revoked_at IS NULL AND c.not_before<=? AND c.accepted_until>?
      AND NOT EXISTS (SELECT 1 FROM runner_pairing p WHERE p.runner_id=r.id AND p.claimed_at IS NULL)
      ORDER BY r.created_at,r.id`,
    )
    .all(scope.workspaceId, scope.userId, since, now, now);
}

const QUEUE = "member.vm.provision";

export function armMemberVmJob(db: Database, id: string, everyMs: number, now: number) {
  const key = `member-vm:${id}`;
  db.run(
    `INSERT INTO job(queue,job_key,payload,priority,run_at,max_attempts,created_at,recurring_every_ms,lane)
    VALUES(?,?,?,5,?,10,?,?,'default') ON CONFLICT(job_key) DO UPDATE SET
    status=CASE WHEN job.status IN ('pending','running') THEN job.status ELSE 'pending' END,
    run_at=CASE WHEN job.status IN ('pending','running') THEN job.run_at ELSE excluded.run_at END,
    attempts=CASE WHEN job.status IN ('pending','running') THEN job.attempts ELSE 0 END,
    finished_at=CASE WHEN job.status IN ('pending','running') THEN job.finished_at ELSE NULL END,
    recurring_every_ms=excluded.recurring_every_ms`,
    [QUEUE, key, JSON.stringify({ id }), now, now, everyMs],
  );
}

export function disarmMemberVmJob(db: Database, jobId: number, lockedBy: string | null) {
  db.run("UPDATE job SET recurring_every_ms=NULL WHERE id=? AND locked_by IS ?", [jobId, lockedBy]);
}

export const MEMBER_VM_QUEUE = QUEUE;

export function runnerPairingByFingerprint(db: Database, requestFingerprint: string) {
  return db
    .query<{ runnerId: string | null; claimedAt: number | null }, [string]>(
      "SELECT runner_id AS runnerId,claimed_at AS claimedAt FROM runner_pairing WHERE request_fingerprint=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(requestFingerprint);
}

export function claimedMemberRunner(
  db: Database,
  input: { runnerId: string; workspaceId: string; userId: string },
): boolean {
  return (
    db
      .query<{ claimed: number }, [string, string, string]>(
        `SELECT 1 AS claimed FROM runner r WHERE r.id=? AND r.workspace_id=? AND r.owner_user_id=?
        AND r.status='active' AND r.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM runner_pairing p WHERE p.runner_id=r.id AND p.claimed_at IS NULL)`,
      )
      .get(input.runnerId, input.workspaceId, input.userId) !== null
  );
}

export function memberRunnerHeartbeat(
  db: Database,
  input: { runnerId: string; workspaceId: string; userId: string; since: number; now: number },
): boolean {
  return (
    db
      .query<{ seen: number }, [string, string, string, number, number, number]>(
        `SELECT 1 AS seen FROM runner r JOIN runner_certificate c ON c.runner_id=r.id
        WHERE r.id=? AND r.workspace_id=? AND r.owner_user_id=? AND r.status='active' AND r.revoked_at IS NULL
        AND r.last_seen_at>=? AND c.rowid=(SELECT MAX(latest.rowid) FROM runner_certificate latest WHERE latest.runner_id=r.id)
        AND c.revoked_at IS NULL AND c.not_before<=? AND c.accepted_until>?
        AND NOT EXISTS (SELECT 1 FROM runner_pairing p WHERE p.runner_id=r.id AND p.claimed_at IS NULL)`,
      )
      .get(input.runnerId, input.workspaceId, input.userId, input.since, input.now, input.now) !==
    null
  );
}

export function memberVmRepositoryGrantRevision(db: Database, binding: OnboardingAdmission) {
  return (
    db
      .query<{ revision: string }, [string, string, string, number]>(
        `SELECT g.revision FROM member_vm_repository_grant g JOIN member_vm v ON v.id=g.vm_id
    WHERE v.workspace_id=? AND v.user_id=? AND g.session_id=? AND g.generation=?`,
      )
      .get(binding.workspaceId, binding.userId, binding.sessionId, binding.generation)?.revision ??
    null
  );
}

export function observeMemberVmRepositoryGrant(
  db: Database,
  binding: OnboardingAdmission,
  expectedRevision: string | null,
  authorized: boolean,
  assertCurrent: () => void,
  now: number,
) {
  return immediate(db, () => {
    assertCurrent();
    if (!binding.repository || expectedRevision === null) return;
    const vm = readMemberVm(db, binding.workspaceId, binding.userId);
    if (!vm || vm.runnerId !== binding.runnerId) return;
    const runner = db
      .query<{ fence: number }, [string, string, string]>(
        "SELECT fence FROM runner WHERE id=? AND workspace_id=? AND owner_user_id=? AND status='active'",
      )
      .get(binding.runnerId, binding.workspaceId, binding.userId);
    if (runner?.fence !== binding.runnerFence) return;
    const changed = db.run(
      authorized
        ? `UPDATE member_vm_repository_grant SET revision=? WHERE vm_id=? AND session_id=? AND generation=? AND repository=? AND revision=?`
        : `DELETE FROM member_vm_repository_grant WHERE vm_id=? AND session_id=? AND generation=? AND repository=? AND revision=?`,
      [
        ...(authorized ? [randomUUID()] : []),
        vm.id,
        binding.sessionId,
        binding.generation,
        `${binding.repository.owner}/${binding.repository.repo}`.toLowerCase(),
        expectedRevision,
      ],
    );
    if (!authorized && changed.changes) armMemberVmJob(db, vm.id, 5000, now);
  });
}
