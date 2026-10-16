import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  approveRunnerPairing,
  createRunnerPairing,
  expireRunnerPairings,
  findRunnerPairing,
  getRunnerCertificate,
  immediate,
  listRunners,
  renewRunnerCertificate,
  isCurrentRunnerCertificate,
  runnerForCertificate,
  updateRunnerStatus,
  workspaceMember,
  type RunnerRecord,
} from "../db";
import { validateRunnerRequest, type RunnerAuthority, type RunnerPeer } from "../runner-identity";
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
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function admin(principal: WorkspacePrincipal, at: number) {
    const member = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!member?.active || !["owner", "admin"].includes(member.role))
      throw new Error("Workspace administrator access is required.");
    if (principal.authenticatedAt > at || at - principal.authenticatedAt > 15 * 60_000)
      throw new Error("Sign in again to manage runners.");
  }
  function authorized(peer: RunnerPeer, at = now()): RunnerRecord {
    const runner = runnerForCertificate(db, peer.fingerprint, at);
    if (!runner) throw new Error("Runner identity is revoked or expired.");
    return runner;
  }
  return {
    async beginPairing(input: { name: string; csr: string }) {
      if (
        input.name.trim().length < 1 ||
        input.name.length > 80 ||
        Array.from(input.name).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error("Runner name must contain between 1 and 80 printable characters.");
      await validateRunnerRequest(options.certificateRoot, input.csr);
      const at = now();
      const id = workspaceId(at);
      const claim = workspaceSecret();
      const code = randomBytes(8).toString("hex").toUpperCase();
      const expiresAt = at + 10 * 60_000;
      const requestFingerprint = createHash("sha256").update(input.csr).digest("hex");
      immediate(db, () => {
        expireRunnerPairings(db, at);
        db.run("DELETE FROM runner_pairing WHERE expires_at<=?", [at]);
        const pending = db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM runner_pairing WHERE runner_id IS NULL",
          )
          .get()!.count;
        if (pending >= 100) throw new Error("Too many runner pairing requests. Try again shortly.");
        createRunnerPairing(db, {
          id,
          claimHash: workspaceTokenHash(claim),
          codeHash: workspaceTokenHash(code),
          csr: input.csr,
          name: input.name.trim(),
          requestFingerprint,
          expiresAt,
          runnerId: null,
          certificateFingerprint: null,
        });
      });
      return {
        id,
        claim,
        code,
        requestFingerprint,
        expiresAt,
      };
    },
    inspectPairing(principal: WorkspacePrincipal, code: string) {
      const at = now();
      admin(principal, at);
      const pairing = findRunnerPairing(db, { codeHash: workspaceTokenHash(code) });
      if (!pairing || pairing.expiresAt <= at || pairing.runnerId !== null)
        throw new Error("Runner pairing is invalid or expired.");
      return {
        name: pairing.name,
        requestFingerprint: pairing.requestFingerprint,
        expiresAt: pairing.expiresAt,
      };
    },
    async approvePairing(principal: WorkspacePrincipal, code: string) {
      admin(principal, now());
      const pairing = findRunnerPairing(db, { codeHash: workspaceTokenHash(code) });
      if (!pairing || pairing.expiresAt <= now() || pairing.runnerId !== null)
        throw new Error("Runner pairing is invalid or expired.");
      const certificate = await options.authority.issue(pairing.csr, undefined, now());
      const at = now();
      const runnerId = workspaceId(at);
      immediate(db, () => {
        admin(principal, at);
        approveRunnerPairing(db, {
          pairingId: pairing.id,
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          certificate,
          now: at,
        });
      });
      return { runnerId };
    },
    claimPairing(id: string, claim: string) {
      const result = immediate(db, () => {
        const at = now();
        expireRunnerPairings(db, at);
        const pairing = findRunnerPairing(db, { id, claimHash: workspaceTokenHash(claim) });
        if (!pairing || pairing.expiresAt <= at) return null;
        if (pairing.runnerId === null || pairing.certificateFingerprint === null)
          return { status: "pending" as const };
        const certificate = getRunnerCertificate(db, pairing.certificateFingerprint);
        const runner = runnerForCertificate(db, pairing.certificateFingerprint, at);
        if (!certificate || !runner) throw new Error("Runner identity is revoked or expired.");
        db.run("UPDATE runner_pairing SET claimed_at=COALESCE(claimed_at,?) WHERE id=?", [
          at,
          pairing.id,
        ]);
        return {
          status: "approved" as const,
          runnerId: runner.id,
          workspaceId: runner.workspaceId,
          certificate: certificate.pem,
          authority: options.authority.certificate,
        };
      });
      if (result === null) throw new Error("Runner pairing is invalid or expired.");
      return result;
    },
    expireConnections() {
      expireRunnerPairings(db, now());
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
      return listRunners(db, principal.workspaceId);
    },
    setStatus(principal: WorkspacePrincipal, runnerId: string, status: RunnerRecord["status"]) {
      const fingerprints = immediate(db, () => {
        const at = now();
        admin(principal, at);
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
