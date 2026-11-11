import { eq } from "drizzle-orm";
import {
  certificateRunnerRevokedSteps,
  expiredRunnerCertificates,
  expiredRunnerCertificatesSteps,
  workspaceMemberUsable,
  agentCatalogSummarySteps,
  auditWorkspaceAccessSteps,
  createRunnerEnrollmentSteps,
  emitJobReady,
  enrollRunnerSteps,
  findRunnerEnrollmentSteps,
  getRunSteps,
  getRunnerSteps,
  getWorkItemSteps,
  listRunnerOverviewSteps,
  renewRunnerCertificateSteps,
  requestAllRunnerAgentUpdatesSteps,
  requestRunnerAgentUpdateSteps,
  isCurrentRunnerCertificateSteps,
  runnerForCertificateSteps,
  sqliteDb,
  type Db,
  type Q,
  setRunnerAdminRepositoriesSteps,
  setRunnerConcurrencySteps,
  updateRunnerStatusSteps,
  workspaceMemberSteps,
  type RunnerRecord,
} from "../db";
import {
  isWorkspaceAdmin,
  workspaceId,
  workspaceSecret,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../workspace";
import { journalCaught } from "../journal";
import { realpathSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { agentCatalogPackages } from "../agent-catalog";
import { validateRunnerRequest, type RunnerAuthority, type RunnerPeer } from "../runner-identity";
import { releaseVersionFromPath } from "../runner-protocol";

export function createRunnerControl(options: {
  db: Database;
  store?: Db;
  authority: RunnerAuthority;
  certificateRoot: string;
  disconnect(fingerprint: string): void;
  now?: () => number;
  /** Installed Paws release, or null for a source checkout. Read from the release path by default. */
  serverVersion?: string | null;
}) {
  const { db } = options;
  const store = options.store ?? sqliteDb(db);
  const now = options.now ?? Date.now;
  const serverVersion =
    options.serverVersion === undefined ? installedVersion() : options.serverVersion;
  function* adminSteps(q: Q, principal: WorkspacePrincipal) {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    if (!workspaceMemberUsable(member) || !isWorkspaceAdmin(member.role))
      throw new Error("Workspace administrator access is required.");
  }
  function* enrollingMemberSteps(q: Q, workspace: string, userId: string) {
    const member = yield* workspaceMemberSteps(q, workspace, userId);
    if (!workspaceMemberUsable(member))
      throw new Error("Active workspace membership is required to own a runner.");
  }
  async function authorized(peer: RunnerPeer, at = now()): Promise<RunnerRecord> {
    const runner = await store.run((q) => runnerForCertificateSteps(q, peer.fingerprint, at));
    if (!runner) throw new Error("Runner identity is revoked or expired.");
    return runner;
  }
  return {
    /**
     * Mint a single-use enrollment token for ten minutes. Any active member may mint one, and owns the runner it produces. The token is returned once; only
     * its hash is stored.
     */
    async createEnrollment(principal: WorkspacePrincipal, input: { name: string }) {
      const name = runnerName(input.name);
      const at = now();
      const id = workspaceId(at);
      const token = workspaceSecret();
      const expiresAt = at + 10 * 60_000;
      await store.transaction(function* (q) {
        yield* enrollingMemberSteps(q, principal.workspaceId, principal.userId);
        yield* createRunnerEnrollmentSteps(q, {
          id,
          tokenHash: workspaceTokenHash(token),
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          name,
          expiresAt,
          now: at,
        });
        yield* auditWorkspaceAccessSteps(q, {
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
      if (!(await store.run((q) => findRunnerEnrollmentSteps(q, tokenHash, now()))))
        throw new RunnerEnrollmentDenied();
      await validateRunnerRequest(options.certificateRoot, input.csr);
      const certificate = await options.authority.issue(input.csr, undefined, now());
      const at = now();
      const runnerId = workspaceId(at);
      let enrollment;
      try {
        enrollment = await store.transaction((q) =>
          enrollRunnerSteps(q, { tokenHash, runnerId, name, certificate, now: at }),
        );
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
      const fingerprints = expiredRunnerCertificates(db, now());
      for (const fingerprint of fingerprints) options.disconnect(fingerprint);
    },
    async expireConnectionsAsync() {
      const at = now();
      for (const fingerprint of await store.run((q) => expiredRunnerCertificatesSteps(q, at)))
        options.disconnect(fingerprint);
    },
    authenticate(peer: RunnerPeer) {
      return authorized(peer);
    },
    revoked(peer: RunnerPeer): Promise<boolean> {
      return store.run((q) => certificateRunnerRevokedSteps(q, peer.fingerprint));
    },
    async list(principal: WorkspacePrincipal, sessionIds: readonly string[]) {
      if (
        !workspaceMemberUsable(
          await store.run((q) => workspaceMemberSteps(q, principal.workspaceId, principal.userId)),
        )
      )
        throw new Error("Workspace membership is required.");
      const scope = new Set(sessionIds);
      const visible = async (runId: string) => {
        const run = await store.run((q) => getRunSteps(q, runId));
        const sessionKey = run
          ? (await store.run((q) => getWorkItemSteps(q, run.itemId)))?.sessionKey
          : null;
        return typeof sessionKey === "string" && scope.has(sessionKey);
      };
      const runners = await store.run((q) =>
        listRunnerOverviewSteps(q, principal.workspaceId, now()),
      );
      const listed = [];
      for (const runner of runners) {
        const running = [];
        for (const session of runner.running)
          if (await visible(session.runId)) running.push(session);
        listed.push({ ...runner, running });
      }
      return listed;
    },
    serverVersion() {
      return serverVersion;
    },
    /** The coding agent versions Paws offers, and the ones it refused. */
    agentVersions() {
      return store.run(agentCatalogSummarySteps);
    },
    async setStatus(
      principal: WorkspacePrincipal,
      runnerId: string,
      status: RunnerRecord["status"],
    ) {
      const fingerprints = await store.transaction(function* (q) {
        const at = now();
        const runner = yield* getRunnerSteps(q, runnerId);
        if (
          runner?.workspaceId === principal.workspaceId &&
          runner.ownerUserId === principal.userId &&
          (status === "active" || status === "paused")
        )
          yield* enrollingMemberSteps(q, principal.workspaceId, principal.userId);
        else yield* adminSteps(q, principal);
        return yield* updateRunnerStatusSteps(q, {
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          status,
          now: at,
        });
      });
      if (status === "active") emitJobReady(store);
      for (const fingerprint of fingerprints) options.disconnect(fingerprint);
    },
    /** Send `version` of `agent` to the runner. Only an eligible catalog version is accepted. */
    async updateAgent(
      principal: WorkspacePrincipal,
      runnerId: string,
      agent: string,
      version: string,
    ) {
      await store.transaction(function* (q) {
        yield* adminSteps(q, principal);
        const at = now();
        yield* requestRunnerAgentUpdateSteps(q, {
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
      return store.transaction(function* (q) {
        yield* adminSteps(q, principal);
        const at = now();
        return yield* requestAllRunnerAgentUpdatesSteps(q, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          now: at,
          id: () => workspaceId(at),
          catalogPackages: (name, nativeVersion) => agentCatalogPackages(db, name, nativeVersion),
        });
      });
    },
    async setConcurrency(principal: WorkspacePrincipal, runnerId: string, concurrency: number) {
      await store.transaction(function* (q) {
        yield* adminSteps(q, principal);
        yield* setRunnerConcurrencySteps(q, {
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          concurrency,
          now: now(),
        });
      });
    },
    async setRepositories(
      principal: WorkspacePrincipal,
      runnerId: string,
      repositories: readonly string[] | null,
    ) {
      const enqueued = await store.transaction(function* (q) {
        yield* adminSteps(q, principal);
        return yield* setRunnerAdminRepositoriesSteps(q, {
          runnerId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          repositories,
          now: now(),
        });
      });
      if (enqueued) emitJobReady(store);
    },
    async renew(peer: RunnerPeer, csr: string) {
      if (!(await store.run((q) => runnerForCertificateSteps(q, peer.fingerprint, now()))))
        throw new Error("Runner identity is revoked or expired.");
      if (!(await store.run((q) => isCurrentRunnerCertificateSteps(q, peer.fingerprint))))
        throw new Error("Runner certificate has been superseded.");
      const certificate = await options.authority.issue(csr, undefined, now());
      const runner = await store.transaction(function* (q) {
        // SQLite's immediate transaction already serializes writers. Postgres needs a
        // row lock before checking which certificate is current so a waiting renewal
        // observes the successor committed by the first transaction.
        if (q.dialect === "postgres")
          yield* q.one(
            q.orm
              .select({ fingerprint: q.t.runnerCertificate.fingerprint })
              .from(q.t.runnerCertificate)
              .where(eq(q.t.runnerCertificate.fingerprint, peer.fingerprint))
              .for("update"),
          );
        if (!(yield* runnerForCertificateSteps(q, peer.fingerprint, now())))
          throw new Error("Runner identity is revoked or expired.");
        return yield* renewRunnerCertificateSteps(q, {
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
  } catch (caughtError1) {
    journalCaught(caughtError1, "pairing.installedVersion.releaseVersionFromPath", null);
    return null;
  }
}
