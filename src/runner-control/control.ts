import { isWorkspaceAdmin } from "../workspace";
import { realpathSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  agentCatalogSummary,
  auditWorkspaceAccess,
  createRunnerEnrollment,
  enrollRunner,
  findRunnerEnrollment,
  getRunner,
  immediate,
  listRunnerOverview,
  renewRunnerCertificate,
  requestAllRunnerAgentUpdates,
  requestRunnerAgentUpdate,
  isCurrentRunnerCertificate,
  runnerForCertificate,
  setRunnerConcurrency,
  updateRunnerStatus,
  workspaceMember,
  type RunnerRecord,
} from "../db";
import { agentCatalogPackages } from "../agent-catalog";
import { validateRunnerRequest, type RunnerAuthority, type RunnerPeer } from "../runner-identity";
import { releaseVersionFromPath } from "../runner-protocol";
import {
  workspaceId,
  workspaceSecret,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../workspace";

export function createRunnerControl(options: {
  db: Database;
  authority: RunnerAuthority;
  certificateRoot: string;
  disconnect(fingerprint: string): void;
  now?: () => number;
  /** Installed Paws release, or null for a source checkout. Read from the release path by default. */
  serverVersion?: string | null;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const serverVersion =
    options.serverVersion === undefined ? installedVersion() : options.serverVersion;
  function admin(principal: WorkspacePrincipal) {
    const member = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!member?.active || !isWorkspaceAdmin(member.role))
      throw new Error("Workspace administrator access is required.");
  }
  function enrollingMember(workspace: string, userId: string) {
    const member = workspaceMember(db, workspace, userId);
    if (!member?.active || member.role === "observer")
      throw new Error("Active workspace membership is required to own a runner.");
  }
  function authorized(peer: RunnerPeer, at = now()): RunnerRecord {
    const runner = runnerForCertificate(db, peer.fingerprint, at);
    if (!runner) throw new Error("Runner identity is revoked or expired.");
    return runner;
  }
  return {
    /**
     * Mint a single-use enrollment token for ten minutes. Any active member who is not an
     * observer may mint one, and owns the runner it produces. The token is returned once; only
     * its hash is stored.
     */
    createEnrollment(principal: WorkspacePrincipal, input: { name: string }) {
      const name = runnerName(input.name);
      const at = now();
      const id = workspaceId(at);
      const token = workspaceSecret();
      const expiresAt = at + 10 * 60_000;
      immediate(db, () => {
        enrollingMember(principal.workspaceId, principal.userId);
        createRunnerEnrollment(db, {
          id,
          tokenHash: workspaceTokenHash(token),
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          name,
          expiresAt,
          now: at,
        });
        auditWorkspaceAccess(db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "runner.enrollment_created",
          subject: id,
          now: at,
        });
      });
      return { token, expiresAt, name };
    },
    /**
     * The host's one round trip: a valid unused token, a name and a CSR give a certificate for a
     * new runner owned by the token's member. Anything else throws and writes nothing.
     */
    async enroll(input: { token: string; name: string; csr: string }) {
      const name = runnerName(input.name);
      const tokenHash = workspaceTokenHash(input.token);
      if (!findRunnerEnrollment(db, tokenHash, now())) throw new RunnerEnrollmentDenied();
      await validateRunnerRequest(options.certificateRoot, input.csr);
      const certificate = await options.authority.issue(input.csr, undefined, now());
      const at = now();
      const runnerId = workspaceId(at);
      let enrollment;
      try {
        enrollment = enrollRunner(db, { tokenHash, runnerId, name, certificate, now: at });
      } catch {
        throw new RunnerEnrollmentDenied();
      }
      return {
        status: "approved" as const,
        runnerId,
        workspaceId: enrollment.workspaceId,
        certificate: certificate.pem,
        authority: options.authority.certificate,
      };
    },
    expireConnections() {
      const fingerprints = db
        .query<{ fingerprint: string }, [number]>(
          `SELECT c.fingerprint FROM runner_certificate c JOIN runner r ON r.id=c.runner_id
        JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
        WHERE c.revoked_at IS NOT NULL OR c.accepted_until<=? OR r.revoked_at IS NOT NULL
        OR r.status='revoked' OR m.active=0`,
        )
        .all(now());
      for (const { fingerprint } of fingerprints) options.disconnect(fingerprint);
    },
    authenticate(peer: RunnerPeer) {
      return authorized(peer);
    },
    list(principal: WorkspacePrincipal) {
      if (!workspaceMember(db, principal.workspaceId, principal.userId)?.active)
        throw new Error("Workspace membership is required.");
      return listRunnerOverview(db, principal.workspaceId, now());
    },
    serverVersion() {
      return serverVersion;
    },
    /** The coding agent versions Paws offers, and the ones it refused. */
    agentVersions() {
      return agentCatalogSummary(db);
    },
    setStatus(principal: WorkspacePrincipal, runnerId: string, status: RunnerRecord["status"]) {
      const fingerprints = immediate(db, () => {
        const at = now();
        const runner = getRunner(db, runnerId);
        if (
          runner?.workspaceId === principal.workspaceId &&
          runner.ownerUserId === principal.userId &&
          (status === "active" || status === "paused")
        )
          enrollingMember(principal.workspaceId, principal.userId);
        else admin(principal);
        return updateRunnerStatus(db, {
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          status,
          now: at,
        });
      });
      for (const fingerprint of fingerprints) options.disconnect(fingerprint);
    },
    /** Send `version` of `agent` to the runner. Only an eligible catalog version is accepted. */
    updateAgent(principal: WorkspacePrincipal, runnerId: string, agent: string, version: string) {
      immediate(db, () => {
        admin(principal);
        const at = now();
        requestRunnerAgentUpdate(db, {
          runnerId,
          agent,
          version,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          now: at,
          id: workspaceId(at),
          catalogPackages: (name, nativeVersion) => agentCatalogPackages(db, name, nativeVersion),
        });
      });
    },
    /** Send each runner the newest eligible version of every agent it is behind on. */
    updateAllAgents(principal: WorkspacePrincipal) {
      return immediate(db, () => {
        admin(principal);
        const at = now();
        return requestAllRunnerAgentUpdates(db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          now: at,
          id: () => workspaceId(at),
          catalogPackages: (name, nativeVersion) => agentCatalogPackages(db, name, nativeVersion),
        });
      });
    },
    setConcurrency(principal: WorkspacePrincipal, runnerId: string, concurrency: number) {
      immediate(db, () => {
        admin(principal);
        setRunnerConcurrency(db, {
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          concurrency,
          now: now(),
        });
      });
    },
    async renew(peer: RunnerPeer, csr: string) {
      authorized(peer);
      if (!isCurrentRunnerCertificate(db, peer.fingerprint))
        throw new Error("Runner certificate has been superseded.");
      const certificate = await options.authority.issue(csr, undefined, now());
      const runner = immediate(db, () => {
        authorized(peer);
        return renewRunnerCertificate(db, {
          previousFingerprint: peer.fingerprint,
          certificate,
          now: now(),
        });
      });
      return {
        runnerId: runner.id,
        workspaceId: runner.workspaceId,
        certificate: certificate.pem,
        authority: options.authority.certificate,
      };
    },
  };
}

export type RunnerControl = ReturnType<typeof createRunnerControl>;

/** A used, expired or unknown enrollment token, or one whose member may no longer own a runner. */
export class RunnerEnrollmentDenied extends Error {
  constructor() {
    super("Runner enrollment is invalid or expired.");
  }
}

function runnerName(name: string): string {
  if (
    name.trim().length < 1 ||
    name.length > 80 ||
    Array.from(name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Runner name must contain between 1 and 80 printable characters.");
  return name.trim();
}

function installedVersion() {
  try {
    return releaseVersionFromPath(realpathSync(import.meta.dir));
  } catch {
    return null;
  }
}
