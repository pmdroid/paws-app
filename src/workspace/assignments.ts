import { canAct } from "./eligibility";
import { journalCaught, journalRejection } from "../journal";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  advanceLinearSessionGeneration,
  auditWorkspaceAccess,
  enqueueJobOnce,
  enqueueOutboxOnce,
  ensureLinearSession,
  getLinearSession,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  immediate,
  listWorkspaceRepositories,
  recordLinearTurn,
  workspaceForOrganization,
  workspaceLinearMember,
  syncWorkspaceMember,
  type JobLoop,
} from "../db";
import {
  linearItem,
  linearReadRetry,
  LinearIntakeRefusedError,
  type AcceptedLinearEvent,
  type EpicSnapshot,
  type IntakeDecision,
  type LinearIssueLifecycle,
  type LinearMembershipReads,
  type TrackerAdapter,
} from "../linear";
import { workspaceTokenHash } from "./session";

const QUEUE = "workspace.assignment";
/** How long a first delegation waits for its delegator to sign in. */
export const ONBOARDING_HOLD_MS = 24 * 60 * 60_000;
/** The one final response when a hold outlives ONBOARDING_HOLD_MS. */
export const ONBOARDING_EXPIRED_BODY =
  "This sign-in link expired. Delegate the issue again to retry.";
const LINK_ID = /^[A-Za-z0-9]{26}$/;
const LINK_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A random onboarding address. It is not a secret: Linear OAuth decides who may use it. */
function onboardingLinkId(): string {
  // 32 symbols divide 256, so `& 31` keeps every symbol equally likely.
  return [...randomBytes(26)].map((byte) => LINK_ALPHABET[byte & 31]).join("");
}

export function assignmentSignInBody(identifier: string): string {
  return [
    `Welcome to Paws. Sign in with Linear so I can start ${identifier}. I'll start on my own once you're set up. You can Stop this anytime.`,
    "Optional: link GitHub on the next page so your commits credit you.",
  ].join("\n\n");
}

/** A signed-in hold: whose onboarding it is and for which issue. Shown only to its creator. */
export type AssignmentOnboarding = {
  hash: string;
  linkId: string;
  workspaceId: string;
  /** The Linear user who started the session. Only they may see the page. */
  actorId: string;
  identifier: string;
  teamId: string;
  teamName: string | null;
  issueUrl: string | null;
  /** Linear user ids of the leads of the issue's Linear projects, who may share a runner. */
  projectLeadIds: string[];
  /** Paws handed the session back to intake. */
  started: boolean;
};

export type AssignmentLink =
  | { state: "pending"; link: string; hash: string }
  /** Onboarding finished. Only the session creator may see where the task stands. */
  | (AssignmentOnboarding & {
      state: "done";
    });

export type AssignmentCompletion =
  | { outcome: "resumed"; identifier: string; linkId: string | null }
  | { outcome: "other-user"; creatorName: string };

type Refusal = Exclude<IntakeDecision, { outcome: "accepted" }>;

type Verified = {
  workspaceId: string;
  actorId: string;
  generation: number;
  teamId: string;
  teamName: string | null;
  identifier: string;
  organizationId: string;
  fingerprint: string;
};

const ACCEPTED: IntakeDecision = { outcome: "accepted" };
const refused = (reason: string): Refusal => ({ outcome: "refused", reason });
const retry = (reason: string): Refusal => ({ outcome: "retry", reason });

const SIGN_IN = "It waits until you sign in to Paws with your Linear account.";
// The session already shows the one sign-in action, so a held delegation posts no error.
const HELD: Refusal = { outcome: "refused", reason: SIGN_IN, quiet: true };
const ENDED = "Paws stopped waiting for this sign-in. Delegate the issue again to retry.";
const STOPPED = "This session was stopped or replaced by a newer delegation.";
const ELSEWHERE = "This session belongs to a different Paws installation.";
export const ASSIGNMENT_CHANGED = "This issue changed while Paws waited for you to sign in.";
const UNRECORDED = retry(
  "Paws has not recorded this session's Linear installation yet. It will try again automatically.",
);

type Hold = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  actorId: string;
  tokenHash: string;
  linkId: string | null;
  linkExpiresAt: number | null;
  fingerprint: string;
  event: string;
  expiresAt: number;
  status: "pending" | "ready" | "accepted" | "continued" | "invalid";
};

const HOLD_COLUMNS = `session_id AS sessionId,generation,workspace_id AS workspaceId,actor_id AS actorId,
    token_hash AS tokenHash,link_id AS linkId,link_expires_at AS linkExpiresAt,fingerprint,event,
    expires_at AS expiresAt,status`;

/** The issue's team and page as Linear reported them when the hold was written. */
function holdIssue(hold: Pick<Hold, "fingerprint">) {
  const fingerprint = JSON.parse(hold.fingerprint) as {
    installation?: { teamId?: unknown };
    issue?: { teamName?: unknown; url?: unknown };
    spec?: { projectLeadId?: unknown; subIssues?: unknown };
  };
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const url = text(fingerprint.issue?.url);
  // The leads of the Linear projects across the delegation, as placement reads them.
  const subIssues = Array.isArray(fingerprint.spec?.subIssues) ? fingerprint.spec.subIssues : [];
  const leads = [fingerprint.spec, ...subIssues].map((issue: unknown) =>
    issue !== null && typeof issue === "object"
      ? text((issue as { projectLeadId?: unknown }).projectLeadId)
      : null,
  );
  return {
    teamId: text(fingerprint.installation?.teamId) ?? "",
    teamName: text(fingerprint.issue?.teamName),
    // Only Linear's own pages become a link on the onboarding page.
    issueUrl: url !== null && url.startsWith("https://linear.app/") ? url : null,
    projectLeadIds: [...new Set(leads.filter((id) => id !== null))].sort(),
  };
}

function holdIdentifier(hold: Pick<Hold, "fingerprint">): string {
  const value = (JSON.parse(hold.fingerprint) as { spec?: { identifier?: unknown } }).spec
    ?.identifier;
  return typeof value === "string" && value !== "" ? value : "this issue";
}

/** The delegator's name from the verified webhook that created the hold. */
function creatorName(hold: Pick<Hold, "event" | "actorId">): string {
  try {
    const event = JSON.parse(hold.event) as { payload?: unknown };
    const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : null;
    const creator = payload?.agentSession?.creator;
    if (
      creator?.id === hold.actorId &&
      typeof creator.name === "string" &&
      creator.name.trim() !== ""
    )
      return creator.name.trim().slice(0, 200);
  } catch (caughtError1) {
    journalCaught(caughtError1, "assignments.creatorName.parse", null);
  }
  return "the person who delegated this issue";
}

export function createWorkspaceAssignments(options: {
  db: Database;
  origin: string;
  clientId: string;
  memberships: LinearMembershipReads;
  /**
   * Uncached membership reads for the one re-check before a held delegation resumes, so a
   * membership lost after sign-in is seen. Defaults to `memberships`.
   */
  resumeMemberships?: LinearMembershipReads;
  lifecycle: LinearIssueLifecycle;
  tracker: TrackerAdapter;
  accept: (event: AcceptedLinearEvent, signal: AbortSignal) => Promise<boolean>;
  continue: (event: AcceptedLinearEvent) => Promise<void | boolean>;
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
        `SELECT ${HOLD_COLUMNS} FROM workspace_assignment WHERE session_id=? ORDER BY generation DESC LIMIT 1`,
      )
      .get(sessionId);
  const byToken = (tokenHash: string) =>
    db
      .query<Hold, [string]>(`SELECT ${HOLD_COLUMNS} FROM workspace_assignment WHERE token_hash=?`)
      .get(tokenHash);
  /** The hold for this token, only while it is the session's latest generation. */
  const currentHold = (tokenHash: string) => {
    const hold = byToken(tokenHash);
    return hold && holds(hold.sessionId)?.tokenHash === tokenHash ? hold : null;
  };
  const expired = (hold: Hold) => (hold.linkExpiresAt ?? hold.expiresAt) <= now();
  function invalidate(hold: Hold) {
    db.run(
      "UPDATE workspace_assignment SET status='invalid' WHERE token_hash=? AND status IN ('pending','ready','accepted')",
      [hold.tokenHash],
    );
  }
  /**
   * Ends a pending hold that outlived its link: one final response that completes the Linear
   * session, a stopped session, and a hold that can no longer start. Runs inside a write
   * transaction.
   */
  function expire(hold: Hold) {
    invalidate(hold);
    const at = now();
    const generation = advanceLinearSessionGeneration(db, hold.sessionId, { stop: true, now: at });
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: hold.sessionId,
      delivery: "stop",
      generation,
      idempotencyKey: `assignment-expired:${hold.tokenHash}`,
      payload: {
        sessionId: hold.sessionId,
        kind: "response",
        body: ONBOARDING_EXPIRED_BODY,
        id: crypto.randomUUID(),
        linearIdentifier: holdIdentifier(hold),
      },
      now: at,
    });
  }
  async function snapshot(
    event: AcceptedLinearEvent,
    signal: AbortSignal,
  ): Promise<Verified | Refusal> {
    if (!event.sessionId || !event.issueId || !options.tracker.getSession)
      return refused("Paws could not match this session to an issue.");
    const generation = getLinearSession(db, event.sessionId)?.generation ?? 0;
    if (!(await options.accept(event, signal)))
      return getLinearSessionInstallation(db, event.sessionId)
        ? refused("Paws cannot access this session or its team in Linear.")
        : UNRECORDED;
    const installation = getLinearSessionInstallation(db, event.sessionId);
    if (!installation) return UNRECORDED;
    if (installation.oauthClientId !== options.clientId || !installation.teamId)
      return refused(ELSEWHERE);
    const workspace = workspaceForOrganization(db, installation.organizationId);
    if (!workspace) return refused("This Linear workspace is not connected to Paws.");
    const session = await options.tracker.getSession(event.sessionId, { signal });
    const issue = await options.lifecycle.inspect(event.issueId, { signal });
    const spec = await options.tracker.loadEpic(event.issueId);
    signal.throwIfAborted();
    if (
      session.id !== event.sessionId ||
      session.issue?.id !== event.issueId ||
      issue.id !== event.issueId ||
      spec.linearIssueId !== event.issueId
    )
      return refused("Linear returned a different issue for this session.");
    if (session.appUserId !== installation.appUserId) return refused(ELSEWHERE);
    if (!session.creatorId || session.creatorId === session.appUserId)
      return refused("Paws could not tell who started this session.");
    if (session.endedAt !== null || session.dismissedAt !== null)
      return refused("This session already ended in Linear.");
    if (issue.teamId !== installation.teamId)
      return refused("This issue is not in the Linear team Paws is installed for.");
    if (!["triage", "backlog", "unstarted", "started"].includes(issue.stateType))
      return refused("This issue is completed or canceled.");
    if (issue.delegateId !== null && issue.delegateId !== installation.appUserId)
      return refused("This issue is delegated to another agent.");
    ensureLinearSession(db, { sessionId: event.sessionId, creatorId: session.creatorId });
    const latest = getLinearSession(db, event.sessionId)!;
    if (
      latest.generation !== generation ||
      latest.stoppedAt !== null ||
      getLinearSessionAccess(db, event.sessionId) !== "allowed"
    )
      return refused(STOPPED);
    const repositories = listWorkspaceRepositories(db, workspace.id);
    return {
      workspaceId: workspace.id,
      actorId: session.creatorId,
      generation,
      teamId: installation.teamId,
      teamName: issue.teamName ?? null,
      identifier: spec.identifier,
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
  function postSignIn(
    hold: Pick<Hold, "sessionId" | "generation" | "actorId" | "fingerprint">,
    link: string,
  ) {
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: hold.sessionId,
      idempotencyKey: `assignment-link:${link}`,
      generation: hold.generation,
      payload: {
        sessionId: hold.sessionId,
        linearIdentifier: holdIdentifier(hold),
        body: assignmentSignInBody(holdIdentifier(hold)),
        auth: {
          url: `${origin.origin}/onboard/${link}`,
          userId: hold.actorId,
          providerName: "Paws",
        },
      },
      now: now(),
    });
  }
  /** Stores the hold and its one sign-in action. A session generation never gets a second one. */
  function issueAction(
    hold: Omit<Hold, "tokenHash" | "linkId" | "linkExpiresAt" | "expiresAt" | "status">,
  ) {
    const link = onboardingLinkId();
    const expiresAt = now() + ONBOARDING_HOLD_MS;
    const inserted = db.run(
      `INSERT INTO workspace_assignment(session_id,generation,workspace_id,actor_id,token_hash,fingerprint,event,expires_at,status,link_id,link_expires_at)
      VALUES(?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(session_id,generation) DO NOTHING`,
      [
        hold.sessionId,
        hold.generation,
        hold.workspaceId,
        hold.actorId,
        workspaceTokenHash(link),
        hold.fingerprint,
        hold.event,
        expiresAt,
        link,
        expiresAt,
      ],
    ).changes;
    if (inserted === 1) postSignIn(hold, link);
  }
  /**
   * Lets a pending hold continue once its creator has a member row that may delegate here,
   * however that row was made: the link, a dashboard sign-in, or a membership sync. Runs inside
   * a write transaction and reads only the database.
   */
  function release(hold: Hold): boolean {
    if (hold.status !== "pending" || expired(hold) || !current(hold)) return false;
    if (holds(hold.sessionId)?.tokenHash !== hold.tokenHash) return false;
    const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
    const expected = JSON.parse(hold.fingerprint) as { installation: { teamId: string } };
    if (
      !canAct({ id: hold.actorId, member, teamId: expected.installation.teamId }, "delegate")
        .allowed
    )
      return false;
    db.run(
      "UPDATE workspace_assignment SET status='ready',completed_at=? WHERE token_hash=? AND status='pending'",
      [now(), hold.tokenHash],
    );
    enqueueJobOnce(db, {
      queue: QUEUE,
      jobKey: `assignment:${hold.tokenHash}`,
      payload: { sessionId: hold.sessionId, tokenHash: hold.tokenHash },
      now: now(),
    });
    return true;
  }
  /** Holds written before link ids existed get one link and one new-form sign-in action. */
  function upgrade() {
    for (const { tokenHash } of db
      .query<{ tokenHash: string }, []>(
        "SELECT token_hash AS tokenHash FROM workspace_assignment WHERE status='pending' AND link_id IS NULL",
      )
      .all())
      immediate(db, () => {
        const hold = byToken(tokenHash);
        if (!hold || hold.status !== "pending" || hold.linkId !== null) return;
        if (holds(hold.sessionId)?.tokenHash !== tokenHash || !current(hold))
          return invalidate(hold);
        const link = onboardingLinkId();
        const expiresAt = now() + ONBOARDING_HOLD_MS;
        db.run(
          `UPDATE workspace_assignment SET link_id=?,link_expires_at=?,expires_at=?,token_hash=?
          WHERE token_hash=? AND status='pending' AND link_id IS NULL`,
          [link, expiresAt, expiresAt, workspaceTokenHash(link), tokenHash],
        );
        postSignIn(hold, link);
      });
  }
  async function ineligible(
    verified: Verified,
    signal: AbortSignal,
    reads: LinearMembershipReads = options.memberships,
  ): Promise<Refusal | null> {
    const before = now();
    const identity = await reads.member(verified.organizationId, verified.actorId, signal);
    signal.throwIfAborted();
    if (identity.organizationId !== verified.organizationId || identity.userId !== verified.actorId)
      return refused("Linear returned a different person for this session.");
    const linked = workspaceLinearMember(db, verified.workspaceId, verified.actorId);
    if (linked)
      syncWorkspaceMember(db, {
        workspaceId: verified.workspaceId,
        userId: linked.userId,
        active: identity.active && !identity.guest,
        role: "member",
        teamIds: identity.teamIds,
        now: before,
      });
    const member = workspaceLinearMember(db, verified.workspaceId, verified.actorId);
    const eligibility = canAct(
      {
        id: verified.actorId,
        identity,
        member,
        teamId: verified.teamId,
      },
      "delegate",
    );
    // A valid Linear member without a Paws sign-in enters the onboarding hold below.
    return eligibility.allowed || eligibility.signIn ? null : refused(eligibility.reason);
  }
  /**
   * The one re-check before a held delegation resumes. It reuses the snapshot stored with the
   * hold and reads only two things from Linear: the issue (team, state and delegate) and a fresh
   * membership. Everything else is a database fact. The epic is compared again at intake, which
   * reads it anyway (`authorizeIntake`).
   */
  async function resumeCheck(
    hold: Hold,
    event: AcceptedLinearEvent,
    signal: AbortSignal,
  ): Promise<Verified | Refusal> {
    const stored = JSON.parse(hold.fingerprint) as {
      installation: { organizationId: string; teamId: string };
      issue: { teamName?: string | null };
      repositories: unknown;
    };
    if (!event.issueId) return refused("Paws could not match this session to an issue.");
    if (!current(hold)) return refused(STOPPED);
    const installation = getLinearSessionInstallation(db, hold.sessionId);
    if (!installation) return UNRECORDED;
    if (installation.oauthClientId !== options.clientId) return refused(ELSEWHERE);
    if (workspaceForOrganization(db, installation.organizationId)?.id !== hold.workspaceId)
      return refused("This Linear workspace is not connected to Paws.");
    if (
      JSON.stringify({ ...installation, observedAtMs: undefined }) !==
        JSON.stringify(stored.installation) ||
      JSON.stringify(listWorkspaceRepositories(db, hold.workspaceId)) !==
        JSON.stringify(stored.repositories)
    )
      return refused(ASSIGNMENT_CHANGED);
    const issue = await options.lifecycle.inspect(event.issueId, { signal });
    signal.throwIfAborted();
    if (JSON.stringify(issue) !== JSON.stringify(stored.issue)) return refused(ASSIGNMENT_CHANGED);
    const verified: Verified = {
      workspaceId: hold.workspaceId,
      actorId: hold.actorId,
      generation: hold.generation,
      teamId: stored.installation.teamId,
      teamName: stored.issue.teamName ?? null,
      identifier: holdIdentifier(hold),
      organizationId: stored.installation.organizationId,
      fingerprint: hold.fingerprint,
    };
    const refusal = await ineligible(
      verified,
      signal,
      options.resumeMemberships ?? options.memberships,
    );
    if (refusal) return refusal;
    return current(hold) ? verified : refused(STOPPED);
  }
  /**
   * Ends a hold that may not resume and tells the session why, once. A stopped or replaced
   * session hears nothing: its generation moved on.
   */
  function refuseHold(hold: Hold, reason: string) {
    immediate(db, () => {
      const latest = holds(hold.sessionId);
      if (latest?.tokenHash !== hold.tokenHash || latest.status === "invalid") return;
      invalidate(hold);
      if (!current(hold)) return;
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: hold.sessionId,
        generation: hold.generation,
        idempotencyKey: `assignment-refused:${hold.tokenHash}`,
        payload: {
          sessionId: hold.sessionId,
          kind: "error",
          body: `Paws did not start this work. ${reason}`,
          linearIdentifier: holdIdentifier(hold),
        },
        now: now(),
      });
    });
  }
  /**
   * A reply from the session creator while the hold waits is kept as a pending
   * Linear turn, so the resumed request delivers it. It posts nothing to Linear.
   * Replies from anyone else are refused and recorded nowhere.
   */
  function keepCreatorReply(event: AcceptedLinearEvent, hold: Hold) {
    if (
      event.action !== "prompted" ||
      !event.sessionId ||
      !event.body?.trim() ||
      !event.actorId ||
      event.actorId !== hold.actorId ||
      hold.status === "invalid" ||
      !current(hold)
    )
      return;
    recordLinearTurn(db, {
      eventKey: event.dedupeKey,
      activityId: event.activityId,
      sessionId: event.sessionId,
      actorId: event.actorId,
      body: event.body,
      payload: event.payload,
      createdAtMs: event.activityCreatedAtMs ?? event.updatedAtMs,
      now: now(),
    });
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
      const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
      if (
        !canAct({ id: hold.actorId, member, teamId: holdIssue(hold).teamId }, "delegate").allowed ||
        JSON.stringify(spec) !== JSON.stringify(expected.spec) ||
        JSON.stringify(listWorkspaceRepositories(db, hold.workspaceId)) !==
          JSON.stringify(expected.repositories)
      ) {
        invalidate(hold);
        return false;
      }
      return true;
    },
    async authorize(event: AcceptedLinearEvent): Promise<IntakeDecision> {
      if (!event.sessionId) return refused("Paws could not match this event to a session.");
      let hold = holds(event.sessionId);
      if (hold && !current(hold)) {
        invalidate(hold);
        if (getLinearSession(db, event.sessionId)?.generation !== hold.generation) hold = null;
      }
      if (event.signal === "stop") {
        if (hold) invalidate(hold);
        return ACCEPTED;
      }
      if (event.action !== "created") {
        if (!hold || hold.status === "continued") return ACCEPTED;
        keepCreatorReply(event, hold);
        return refused(SIGN_IN);
      }
      if (hold) {
        if (!continuations.has(event) || hold.status !== "accepted" || !current(hold))
          return hold.status === "invalid" ? refused(ENDED) : HELD;
        // The job that runs this continuation just re-checked the issue and the membership
        // against the stored snapshot, so this reads only the database.
        const { teamId } = holdIssue(hold);
        const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
        const eligibility = canAct({ id: hold.actorId, member, teamId }, "delegate");
        if (!eligibility.allowed) return refused(eligibility.reason);
        return current(hold) && holds(hold.sessionId)?.status === "accepted"
          ? ACCEPTED
          : refused(STOPPED);
      }
      const signal = AbortSignal.timeout(30_000);
      const verified = await snapshot(event, signal).catch(
        journalRejection(
          "workspace/assignments.createWorkspaceAssignments.snapshot",
          linearReadRetry,
          null,
        ),
      );
      if ("outcome" in verified) return verified;
      const refusal = await ineligible(verified, signal).catch(
        journalRejection(
          "workspace/assignments.createWorkspaceAssignments.ineligible",
          linearReadRetry,
          null,
        ),
      );
      if (refusal) return refusal;
      const currentSession = getLinearSession(db, event.sessionId);
      if (
        currentSession?.generation !== verified.generation ||
        currentSession.stoppedAt !== null ||
        getLinearSessionAccess(db, event.sessionId) !== "allowed"
      )
        return refused(STOPPED);
      if (workspaceLinearMember(db, verified.workspaceId, verified.actorId) !== null)
        return ACCEPTED;
      return immediate(db, () => {
        if (holds(event.sessionId!)?.generation === verified.generation) return HELD;
        const session = getLinearSession(db, event.sessionId!)!;
        if (
          session.generation !== verified.generation ||
          session.stoppedAt !== null ||
          getLinearSessionAccess(db, event.sessionId!) !== "allowed"
        )
          return refused(STOPPED);
        issueAction({
          sessionId: event.sessionId!,
          generation: verified.generation,
          workspaceId: verified.workspaceId,
          actorId: verified.actorId,
          fingerprint: verified.fingerprint,
          event: JSON.stringify(event),
        });
        return HELD;
      });
    },
    recheck(event: AcceptedLinearEvent): boolean {
      if (!event.sessionId || event.action !== "created" || event.signal === "stop") return true;
      return (
        getLinearSession(db, event.sessionId)?.stoppedAt === null &&
        getLinearSessionAccess(db, event.sessionId) === "allowed"
      );
    },
    /** The issue a hold waits on, for counting its Linear requests. Grants nothing. */
    issueIdentifier(hash: string): string | null {
      const hold = byToken(hash);
      return hold ? holdIdentifier(hold) : null;
    },
    /** Resolves an /onboard/<link id> address. The id alone grants nothing. */
    open(link: string): AssignmentLink | null {
      if (!LINK_ID.test(link)) return null;
      const row = db
        .query<{ tokenHash: string }, [string]>(
          "SELECT token_hash AS tokenHash FROM workspace_assignment WHERE link_id=?",
        )
        .get(link);
      const hold = row ? currentHold(row.tokenHash) : null;
      if (!hold) return null;
      if (hold.status === "pending")
        return !expired(hold) && current(hold)
          ? { state: "pending", link, hash: hold.tokenHash }
          : null;
      // A stopped or replaced session ends its onboarding page too.
      if (hold.status === "invalid" || !current(hold)) return null;
      return {
        state: "done",
        hash: hold.tokenHash,
        linkId: link,
        workspaceId: hold.workspaceId,
        actorId: hold.actorId,
        identifier: holdIdentifier(hold),
        ...holdIssue(hold),
        started: hold.status === "continued",
      };
    },
    /**
     * Finishes a link sign-in. Only the session creator moves the hold; anyone else learns whose
     * link it is and changes nothing. A creator who signs in again after the hold moved on is sent
     * back to their onboarding page. Throws when the hold can no longer continue.
     */
    complete(hash: string, workspaceId: string, linearUserId: string): AssignmentCompletion {
      return immediate(db, (): AssignmentCompletion => {
        const hold = currentHold(hash);
        if (
          !hold ||
          hold.workspaceId !== workspaceId ||
          hold.status === "invalid" ||
          !current(hold) ||
          (hold.status === "pending" && expired(hold))
        )
          throw new Error("Assignment sign-in is unavailable.");
        if (hold.actorId !== linearUserId)
          return { outcome: "other-user", creatorName: creatorName(hold) };
        if (hold.status === "pending" && !release(hold))
          throw new Error("Assignment membership is unavailable.");
        return { outcome: "resumed", identifier: holdIdentifier(hold), linkId: hold.linkId };
      });
    },
    /** A dashboard sign-in releases the signer's own pending holds without a new action. */
    releaseFor(workspaceId: string, linearUserId: string): void {
      for (const { tokenHash } of db
        .query<{ tokenHash: string }, [string, string]>(
          "SELECT token_hash AS tokenHash FROM workspace_assignment WHERE workspace_id=? AND actor_id=? AND status='pending'",
        )
        .all(workspaceId, linearUserId))
        immediate(db, () => {
          const hold = byToken(tokenHash);
          if (hold) release(hold);
        });
    },
    register(jobs: JobLoop) {
      enqueueJobOnce(db, {
        queue: `${QUEUE}.expire`,
        jobKey: `${QUEUE}.expire`,
        recurringEveryMs: 60_000,
        now: now(),
      });
      upgrade();
      // Waiting writes nothing to Linear. This sweep ends holds whose session moved on, lets a
      // hold continue once its creator has a member row (for example after signing in from the
      // dashboard instead of the link), and gives a hold past ONBOARDING_HOLD_MS its one final
      // response.
      jobs.register(`${QUEUE}.expire`, () => {
        upgrade();
        for (const { tokenHash } of db
          .query<{ tokenHash: string }, []>(
            "SELECT token_hash AS tokenHash FROM workspace_assignment WHERE status='pending' AND link_id IS NOT NULL",
          )
          .all())
          immediate(db, () => {
            const hold = byToken(tokenHash);
            if (!hold || hold.status !== "pending") return;
            if (holds(hold.sessionId)?.tokenHash !== tokenHash || !current(hold))
              return invalidate(hold);
            if (expired(hold)) return expire(hold);
            release(hold);
          });
      });
      jobs.register(QUEUE, async (job, context) => {
        const payload = job.payload as { sessionId: string; tokenHash: string };
        const hold = holds(payload.sessionId);
        if (
          !hold ||
          hold.tokenHash !== payload.tokenHash ||
          !["ready", "accepted"].includes(hold.status)
        )
          return;
        const event: AcceptedLinearEvent = JSON.parse(hold.event);
        // Every Linear request of the resume counts toward the issue under /health linear.items.
        await linearItem(holdIdentifier(hold), async () => {
          const verified = await resumeCheck(hold, event, context.signal).catch(
            journalRejection(
              "workspace/assignments.createWorkspaceAssignments.resumeCheck",
              linearReadRetry,
              null,
            ),
          );
          if ("outcome" in verified) {
            if (verified.outcome === "retry") throw new Error(verified.reason);
            return refuseHold(hold, verified.reason);
          }
          const accepted = immediate(db, () => {
            if (!context.isCurrent()) throw new Error("Assignment job claim is no longer current.");
            if (!current(hold) || holds(hold.sessionId)?.status === "invalid") {
              invalidate(hold);
              return false;
            }
            const member = workspaceLinearMember(db, hold.workspaceId, hold.actorId);
            if (
              member === null ||
              !canAct({ id: hold.actorId, member, teamId: verified.teamId }, "delegate").allowed
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
          if (!accepted) return;
          continuations.add(event);
          try {
            const result = await options.continue(event);
            if (result === false) throw new Error("Assignment continuation is still held.");
            db.run(
              "UPDATE workspace_assignment SET status='continued' WHERE token_hash=? AND status='accepted'",
              [hold.tokenHash],
            );
          } catch (error) {
            // A refusal is final for this hold: say why once instead of retrying the job.
            if (!(error instanceof LinearIntakeRefusedError)) throw error;
            journalCaught(error, "assignments.register.continue", null);
            if (error.quiet) invalidate(hold);
            else refuseHold(hold, error.message);
          } finally {
            continuations.delete(event);
          }
        });
      });
    },
  };
}

export type WorkspaceAssignments = ReturnType<typeof createWorkspaceAssignments>;
