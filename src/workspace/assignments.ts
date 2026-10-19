import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  enqueueJobOnce,
  enqueueOutboxOnce,
  ensureLinearSession,
  getLinearSession,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  immediate,
  listWorkspaceRepositories,
  workspaceForOrganization,
  workspaceLinearMember,
  syncWorkspaceMember,
  type JobLoop,
} from "../db";
import type {
  AcceptedLinearEvent,
  EpicSnapshot,
  LinearIssueLifecycle,
  LinearMembershipReads,
  TrackerAdapter,
} from "../linear";
import { workspaceSecret, workspaceTokenHash, type WorkspacePrincipal } from "./session";

const QUEUE = "workspace.assignment";

type Hold = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  actorId: string;
  tokenHash: string;
  fingerprint: string;
  event: string;
  expiresAt: number;
  status: "pending" | "ready" | "accepted" | "continued" | "invalid";
};

export function createWorkspaceAssignments(options: {
  db: Database;
  origin: string;
  clientId: string;
  memberships: LinearMembershipReads;
  lifecycle: LinearIssueLifecycle;
  tracker: TrackerAdapter;
  accept: (event: AcceptedLinearEvent, signal: AbortSignal) => Promise<boolean>;
  continue: (event: AcceptedLinearEvent) => Promise<void | boolean>;
  onboarding?: {
    readyToContinue?: (assignment: {
      sessionId: string;
      generation: number;
      workspaceId: string;
      linearUserId: string;
    }) => boolean;
  };
  now?: () => number;
}) {
  const { db } = options;
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("Assignment sign-in requires verified HTTPS.");
  const now = options.now ?? Date.now;
  const continuations = new WeakSet<AcceptedLinearEvent>();
  const holds = (sessionId: string) =>
    db
      .query<Hold, [string]>(
        `SELECT session_id AS sessionId,generation,workspace_id AS workspaceId,actor_id AS actorId,
    token_hash AS tokenHash,fingerprint,event,expires_at AS expiresAt,status
    FROM workspace_assignment WHERE session_id=? ORDER BY generation DESC LIMIT 1`,
      )
      .get(sessionId);
  function invalidate(hold: Hold) {
    db.run(
      "UPDATE workspace_assignment SET status='invalid' WHERE token_hash=? AND status IN ('pending','ready','accepted')",
      [hold.tokenHash],
    );
  }
  async function snapshot(event: AcceptedLinearEvent, signal: AbortSignal) {
    if (!event.sessionId || !event.issueId || !options.tracker.getSession) return null;
    const generation = getLinearSession(db, event.sessionId)?.generation ?? 0;
    if (!(await options.accept(event, signal))) return null;
    const installation = getLinearSessionInstallation(db, event.sessionId);
    if (!installation || installation.oauthClientId !== options.clientId || !installation.teamId)
      return null;
    const workspace = workspaceForOrganization(db, installation.organizationId);
    if (!workspace) return null;
    const session = await options.tracker.getSession(event.sessionId, { signal });
    const issue = await options.lifecycle.inspect(event.issueId, { signal });
    const spec = await options.tracker.loadEpic(event.issueId);
    signal.throwIfAborted();
    if (
      session.id !== event.sessionId ||
      session.issue?.id !== event.issueId ||
      session.appUserId !== installation.appUserId ||
      !session.creatorId ||
      session.creatorId === session.appUserId ||
      session.endedAt !== null ||
      session.dismissedAt !== null ||
      issue.id !== event.issueId ||
      issue.teamId !== installation.teamId ||
      !["triage", "backlog", "unstarted", "started"].includes(issue.stateType) ||
      (issue.delegateId !== null && issue.delegateId !== installation.appUserId) ||
      spec.linearIssueId !== event.issueId
    )
      return null;
    ensureLinearSession(db, { sessionId: event.sessionId, creatorId: session.creatorId });
    const latest = getLinearSession(db, event.sessionId)!;
    if (
      latest.generation !== generation ||
      latest.stoppedAt !== null ||
      getLinearSessionAccess(db, event.sessionId) !== "allowed"
    )
      return null;
    const repositories = listWorkspaceRepositories(db, workspace.id);
    return {
      workspaceId: workspace.id,
      actorId: session.creatorId,
      generation,
      teamId: installation.teamId,
      organizationId: installation.organizationId,
      fingerprint: JSON.stringify({
        installation: { ...installation, observedAtMs: undefined },
        issue,
        spec,
        repositories,
      }),
    };
  }
  function current(hold: Hold) {
    const session = getLinearSession(db, hold.sessionId);
    return (
      session?.generation === hold.generation &&
      session.stoppedAt === null &&
      getLinearSessionAccess(db, hold.sessionId) === "allowed" &&
      session.creatorId === hold.actorId
    );
  }
  function issueAction(hold: Omit<Hold, "tokenHash" | "expiresAt" | "status">) {
    const token = workspaceSecret();
    const tokenHash = workspaceTokenHash(token);
    const expiresAt = now() + 10 * 60_000;
    db.run(
      `INSERT INTO workspace_assignment(session_id,generation,workspace_id,actor_id,token_hash,fingerprint,event,expires_at,status)
      VALUES(?,?,?,?,?,?,?,?,'pending') ON CONFLICT(session_id,generation) DO UPDATE SET
      token_hash=excluded.token_hash,expires_at=excluded.expires_at WHERE workspace_assignment.status='pending'`,
      [
        hold.sessionId,
        hold.generation,
        hold.workspaceId,
        hold.actorId,
        tokenHash,
        hold.fingerprint,
        hold.event,
        expiresAt,
      ],
    );
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: hold.sessionId,
      idempotencyKey: `assignment:${tokenHash}`,
      generation: hold.generation,
      payload: {
        sessionId: hold.sessionId,
        body: "Sign in to Paws with your Linear account to continue this assignment. You can Stop this assignment in Linear.",
        auth: {
          url: `${origin.origin}/auth/linear?assignment=${token}`,
          userId: hold.actorId,
          providerName: "Paws",
        },
      },
      now: now(),
    });
  }
  async function eligible(
    verified: NonNullable<Awaited<ReturnType<typeof snapshot>>>,
    signal: AbortSignal,
  ) {
    const before = now();
    const identity = await options.memberships.member(
      verified.organizationId,
      verified.actorId,
      signal,
    );
    signal.throwIfAborted();
    if (identity.organizationId !== verified.organizationId || identity.userId !== verified.actorId)
      return false;
    const linked = workspaceLinearMember(db, verified.workspaceId, verified.actorId);
    if (linked)
      syncWorkspaceMember(db, {
        workspaceId: verified.workspaceId,
        userId: linked.userId,
        active: identity.active,
        role: identity.guest ? "observer" : "member",
        teamIds: identity.teamIds,
        now: before,
      });
    const member = workspaceLinearMember(db, verified.workspaceId, verified.actorId);
    return (
      identity.organizationId === verified.organizationId &&
      identity.userId === verified.actorId &&
      identity.active &&
      !identity.guest &&
      identity.teamIds.includes(verified.teamId) &&
      (member === null ||
        (member.active &&
          member.role !== "observer" &&
          member.teamIds.includes(verified.teamId) &&
          member.checkedAt <= before))
    );
  }
  function ready(hold: Hold) {
    if (!options.onboarding) return true;
    return (
      options.onboarding.readyToContinue?.({
        sessionId: hold.sessionId,
        generation: hold.generation,
        workspaceId: hold.workspaceId,
        linearUserId: hold.actorId,
      }) === true
    );
  }
  return {
    authorizeIntake(sessionId: string, spec: EpicSnapshot): boolean {
      const hold = holds(sessionId);
      if (!hold) return true;
      if (hold.status !== "accepted" || !current(hold)) return hold.status === "continued";
      const expected = JSON.parse(hold.fingerprint) as {
        spec: EpicSnapshot;
        repositories: unknown;
      };
      if (!ready(hold)) return false;
      const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
      if (
        !member?.active ||
        member.role === "observer" ||
        JSON.stringify(spec) !== JSON.stringify(expected.spec) ||
        JSON.stringify(listWorkspaceRepositories(db, hold.workspaceId)) !==
          JSON.stringify(expected.repositories)
      ) {
        invalidate(hold);
        return false;
      }
      return true;
    },
    async authorize(event: AcceptedLinearEvent): Promise<boolean> {
      if (!event.sessionId) return false;
      let hold = holds(event.sessionId);
      if (hold && !current(hold)) {
        invalidate(hold);
        if (getLinearSession(db, event.sessionId)?.generation !== hold.generation) hold = null;
      }
      if (event.signal === "stop") {
        if (hold) invalidate(hold);
        return true;
      }
      if (event.action !== "created") return !hold || hold.status === "continued";
      if (hold) {
        if (!continuations.has(event) || hold.status !== "accepted" || !current(hold)) return false;
        const signal = AbortSignal.timeout(30_000);
        const verified = await snapshot(event, signal);
        return (
          verified !== null &&
          verified.fingerprint === hold.fingerprint &&
          (await eligible(verified, signal)) &&
          current(hold) &&
          ready(hold) &&
          holds(hold.sessionId)?.status === "accepted"
        );
      }
      const signal = AbortSignal.timeout(30_000);
      const verified = await snapshot(event, signal);
      if (!verified || !(await eligible(verified, signal))) return false;
      const currentSession = getLinearSession(db, event.sessionId);
      if (
        currentSession?.generation !== verified.generation ||
        currentSession.stoppedAt !== null ||
        getLinearSessionAccess(db, event.sessionId) !== "allowed"
      )
        return false;
      if (workspaceLinearMember(db, verified.workspaceId, verified.actorId) !== null) return true;
      return immediate(db, () => {
        if (holds(event.sessionId!)?.generation === verified.generation) return false;
        const session = getLinearSession(db, event.sessionId!)!;
        if (
          session.generation !== verified.generation ||
          session.stoppedAt !== null ||
          getLinearSessionAccess(db, event.sessionId!) !== "allowed"
        )
          return false;
        issueAction({ sessionId: event.sessionId!, ...verified, event: JSON.stringify(event) });
        return false;
      });
    },
    begin(token: string): string | null {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const hash = workspaceTokenHash(token);
      const hold = db
        .query<{ sessionId: string }, [string, number]>(
          "SELECT session_id AS sessionId FROM workspace_assignment WHERE token_hash=? AND status='pending' AND expires_at>? ",
        )
        .get(hash, now());
      const value = hold ? holds(hold.sessionId) : null;
      return value && current(value) ? hash : null;
    },
    beginReturn(path: string): string | null {
      const match = /^\/status\/onboarding\/([A-Za-z0-9_-]{1,128})\/(0|[1-9][0-9]{0,9})$/.exec(
        path,
      );
      if (!options.onboarding || !match) return null;
      const hold = holds(match[1]!);
      return hold &&
        hold.generation === Number(match[2]) &&
        ["ready", "accepted", "continued"].includes(hold.status) &&
        current(hold)
        ? `onboarding:${hold.tokenHash}`
        : null;
    },
    completeReturn(context: string, workspaceId: string, linearUserId: string): string {
      const hash = context.slice("onboarding:".length);
      const row = db
        .query<{ sessionId: string }, [string]>(
          "SELECT session_id AS sessionId FROM workspace_assignment WHERE token_hash=?",
        )
        .get(hash);
      const hold = row ? holds(row.sessionId) : null;
      const member = workspaceLinearMember(db, workspaceId, linearUserId);
      if (
        !hold ||
        hold.tokenHash !== hash ||
        !member ||
        !this.onboarding(hold.sessionId, hold.generation, {
          workspaceId,
          userId: member.userId,
          role: member.role,
          teamIds: member.teamIds,
          authenticatedAt: now(),
        })
      )
        throw new Error("Onboarding return is unavailable.");
      return `/status/onboarding/${encodeURIComponent(hold.sessionId)}/${hold.generation}`;
    },
    onboarding(sessionId: string, generation: number, principal: WorkspacePrincipal) {
      if (!options.onboarding) return null;
      const hold = holds(sessionId);
      if (
        !hold ||
        hold.generation !== generation ||
        hold.workspaceId !== principal.workspaceId ||
        !["ready", "accepted", "continued"].includes(hold.status) ||
        !current(hold)
      )
        return null;
      const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
      const expected = JSON.parse(hold.fingerprint) as {
        installation: {
          teamId: string;
          organizationId: string;
          oauthClientId: string;
          appUserId: string;
        };
        spec: EpicSnapshot;
      };
      const installation = getLinearSessionInstallation(db, sessionId);
      if (
        !member?.active ||
        member.userId !== principal.userId ||
        member.role === "observer" ||
        !member.teamIds.includes(expected.installation.teamId) ||
        !installation ||
        installation.organizationId !== expected.installation.organizationId ||
        installation.oauthClientId !== expected.installation.oauthClientId ||
        installation.appUserId !== expected.installation.appUserId ||
        installation.teamId !== expected.installation.teamId ||
        getLinearSession(db, sessionId)?.issueId !== expected.spec.linearIssueId
      )
        return null;
      return {
        issue: {
          id: expected.spec.linearIssueId,
          identifier: expected.spec.identifier,
          title: expected.spec.title,
        },
        linear: { state: "connected", detail: "Linear connected" },
        github: { state: "not_checked", detail: "Member repository access has not been checked." },
        vm: { state: "not_linked", detail: "No VM is linked to this assignment." },
      };
    },
    complete(hash: string, workspaceId: string, linearUserId: string): string {
      return immediate(db, () => {
        const row = db
          .query<{ sessionId: string }, [string]>(
            "SELECT session_id AS sessionId FROM workspace_assignment WHERE token_hash=?",
          )
          .get(hash);
        const hold = row ? holds(row.sessionId) : null;
        if (
          !hold ||
          hold.tokenHash !== hash ||
          hold.workspaceId !== workspaceId ||
          hold.actorId !== linearUserId ||
          hold.status !== "pending" ||
          hold.expiresAt <= now() ||
          !current(hold)
        )
          throw new Error("Assignment sign-in is unavailable.");
        const member = workspaceLinearMember(db, workspaceId, linearUserId);
        const expected = JSON.parse(hold.fingerprint) as { installation: { teamId: string } };
        if (
          !member?.active ||
          member.role === "observer" ||
          !member.teamIds.includes(expected.installation.teamId)
        )
          throw new Error("Assignment membership is unavailable.");
        db.run("UPDATE workspace_assignment SET status='ready' WHERE token_hash=?", [hash]);
        enqueueJobOnce(db, {
          queue: QUEUE,
          jobKey: `assignment:${hash}`,
          payload: { sessionId: hold.sessionId, tokenHash: hash },
          ...(options.onboarding ? { recurringEveryMs: 60_000 } : {}),
          now: now(),
        });
        if (!options.onboarding) return "/status/";
        const path = `/status/onboarding/${encodeURIComponent(hold.sessionId)}/${hold.generation}`;
        enqueueOutboxOnce(db, {
          target: "linear",
          op: "activity",
          orderingKey: hold.sessionId,
          idempotencyKey: `assignment:onboarding:${hash}`,
          generation: hold.generation,
          payload: {
            sessionId: hold.sessionId,
            kind: "thought",
            body: `Linear connected. Member GitHub repository access has not been checked. No VM is linked to this assignment. Your assignment waits for setup. [View onboarding](${origin.origin}${path}). You can close the page or Stop this assignment in Linear.`,
          },
          now: now(),
        });
        return path;
      });
    },
    register(jobs: JobLoop) {
      if (options.onboarding)
        db.run(
          "UPDATE job SET recurring_every_ms=60000 WHERE queue=? AND status IN ('pending','running') AND recurring_every_ms IS NULL",
          [QUEUE],
        );
      enqueueJobOnce(db, {
        queue: `${QUEUE}.expire`,
        jobKey: `${QUEUE}.expire`,
        recurringEveryMs: 60_000,
        now: now(),
      });
      jobs.register(`${QUEUE}.expire`, () => {
        for (const row of db
          .query<{ sessionId: string }, [number]>(
            "SELECT session_id AS sessionId FROM workspace_assignment WHERE status='pending' AND expires_at<=?",
          )
          .all(now())) {
          const hold = holds(row.sessionId)!;
          immediate(db, () => (current(hold) ? issueAction(hold) : invalidate(hold)));
        }
      });
      jobs.register(QUEUE, async (job, context) => {
        const payload = job.payload as { sessionId: string; tokenHash: string };
        const hold = holds(payload.sessionId);
        if (
          !hold ||
          hold.tokenHash !== payload.tokenHash ||
          !["ready", "accepted"].includes(hold.status)
        ) {
          if (context.isCurrent()) {
            db.run("UPDATE job SET recurring_every_ms=NULL WHERE id=? AND locked_by=?", [
              job.id,
              job.lockedBy,
            ]);
            job.recurringEveryMs = null;
          }
          return;
        }
        if (!current(hold)) {
          invalidate(hold);
          return;
        }
        if (!ready(hold)) return;
        const event: AcceptedLinearEvent = JSON.parse(hold.event);
        const verified = await snapshot(event, context.signal);
        if (
          !verified ||
          verified.fingerprint !== hold.fingerprint ||
          verified.actorId !== hold.actorId ||
          verified.workspaceId !== hold.workspaceId ||
          !(await eligible(verified, context.signal))
        ) {
          invalidate(hold);
          return;
        }
        if (!ready(hold)) return;
        const accepted = immediate(db, () => {
          if (!context.isCurrent()) throw new Error("Assignment job claim is no longer current.");
          if (!current(hold) || holds(hold.sessionId)?.status === "invalid") {
            invalidate(hold);
            return false;
          }
          if (!ready(hold)) return false;
          const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
          if (
            !member?.active ||
            member.role === "observer" ||
            !member.teamIds.includes(verified.teamId)
          ) {
            invalidate(hold);
            return false;
          }
          if (hold.status === "ready") {
            db.run(
              "UPDATE workspace_assignment SET status='accepted' WHERE token_hash=? AND status='ready'",
              [hold.tokenHash],
            );
            auditWorkspaceAccess(db, {
              workspaceId: hold.workspaceId,
              userId: member.userId,
              action: "assignment.resumed",
              subject: hold.sessionId,
              now: now(),
            });
          }
          return true;
        });
        if (accepted) {
          continuations.add(event);
          try {
            const result = await options.continue(event);
            if (result === false) throw new Error("Assignment continuation is still held.");
            db.run(
              "UPDATE workspace_assignment SET status='continued' WHERE token_hash=? AND status='accepted'",
              [hold.tokenHash],
            );
          } finally {
            continuations.delete(event);
          }
        }
      });
    },
  };
}

export type WorkspaceAssignments = ReturnType<typeof createWorkspaceAssignments>;
