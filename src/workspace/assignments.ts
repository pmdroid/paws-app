import { canAct, LINEAR_GUEST_REFUSAL } from "./eligibility";
import { journalCaught, journalRejection } from "../journal";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  advanceLinearSessionGenerationSteps,
  auditWorkspaceAccessSteps,
  emitJobReady,
  enqueueJobOnceAsync,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  ensureLinearSessionSteps,
  getLinearSessionAccessSteps,
  getLinearSessionInstallationSteps,
  getLinearSessionSteps,
  insertWorkspaceAssignmentSteps,
  invalidateWorkspaceAssignmentSteps,
  latestWorkspaceAssignmentSteps,
  linkWorkspaceAssignmentSteps,
  listWorkspaceRepositoriesSteps,
  moveWorkspaceAssignmentSteps,
  pendingWorkspaceAssignmentTokensSteps,
  recordLinearTurnSteps,
  settled,
  sqliteDb,
  syncWorkspaceMemberSteps,
  workspaceAssignmentByTokenSteps,
  workspaceAssignmentTokenForLinkSteps,
  workspaceForOrganizationSteps,
  workspaceLinearMemberSteps,
  type JobLoop,
  type Q,
  type Steps,
  type WorkspaceAssignmentHold,
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
const refused = (reason: string, response?: true): Refusal => ({
  outcome: "refused",
  reason,
  ...(response ? { response } : {}),
});
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

type Hold = WorkspaceAssignmentHold;

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
  const store = sqliteDb(options.db);
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("Assignment sign-in requires verified HTTPS.");
  const now = options.now ?? Date.now;
  const continuations = new WeakSet<AcceptedLinearEvent>();
  const holdsSteps = (q: Q, sessionId: string) => latestWorkspaceAssignmentSteps(q, sessionId);
  const holds = (sessionId: string) => store.run((q) => holdsSteps(q, sessionId));
  const byTokenSteps = (q: Q, tokenHash: string) => workspaceAssignmentByTokenSteps(q, tokenHash);
  /** The hold for this token, only while it is the session's latest generation. */
  function* currentHoldSteps(q: Q, tokenHash: string) {
    const hold = yield* byTokenSteps(q, tokenHash);
    return hold && (yield* holdsSteps(q, hold.sessionId))?.tokenHash === tokenHash ? hold : null;
  }
  const expired = (hold: Hold) => (hold.linkExpiresAt ?? hold.expiresAt) <= now();
  const invalidateSteps = (q: Q, hold: Hold) =>
    invalidateWorkspaceAssignmentSteps(q, hold.tokenHash);
  const invalidate = (hold: Hold) => store.run((q) => invalidateSteps(q, hold));
  /**
   * Ends a pending hold that outlived its link: one final response that completes the Linear
   * session, a stopped session, and a hold that can no longer start. Runs inside a write
   * transaction.
   */
  function* expireSteps(q: Q, hold: Hold) {
    yield* invalidateSteps(q, hold);
    const at = now();
    const generation = yield* advanceLinearSessionGenerationSteps(q, hold.sessionId, {
      stop: true,
      now: at,
    });
    yield* enqueueOutboxOnceSteps(q, {
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
    const sessionId = event.sessionId;
    const installationOf = () => store.run((q) => getLinearSessionInstallationSteps(q, sessionId));
    const generation =
      (await store.run((q) => getLinearSessionSteps(q, sessionId)))?.generation ?? 0;
    if (!(await options.accept(event, signal)))
      return (await installationOf())
        ? refused("Paws cannot access this session or its team in Linear.")
        : UNRECORDED;
    const installation = await installationOf();
    if (!installation) return UNRECORDED;
    if (installation.oauthClientId !== options.clientId || !installation.teamId)
      return refused(ELSEWHERE);
    const workspace = await store.run((q) =>
      workspaceForOrganizationSteps(q, installation.organizationId),
    );
    if (!workspace) return refused("This Linear workspace is not connected to Paws.");
    const session = await options.tracker.getSession(sessionId, { signal });
    const issue = await options.lifecycle.inspect(event.issueId, { signal });
    const spec = await options.tracker.loadEpic(event.issueId);
    signal.throwIfAborted();
    if (
      session.id !== sessionId ||
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
    const creatorId = session.creatorId;
    await store.transaction((q) => ensureLinearSessionSteps(q, { sessionId, creatorId }));
    const latest = (await store.run((q) => getLinearSessionSteps(q, sessionId)))!;
    if (
      latest.generation !== generation ||
      latest.stoppedAt !== null ||
      (await store.run((q) => getLinearSessionAccessSteps(q, sessionId))) !== "allowed"
    )
      return refused(STOPPED);
    const repositories = await store.run((q) => listWorkspaceRepositoriesSteps(q, workspace.id));
    return {
      workspaceId: workspace.id,
      actorId: creatorId,
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
  function* currentSteps(q: Q, hold: Hold) {
    const session = yield* getLinearSessionSteps(q, hold.sessionId);
    return (
      session?.generation === hold.generation &&
      session.stoppedAt === null &&
      (yield* getLinearSessionAccessSteps(q, hold.sessionId)) === "allowed" &&
      session.creatorId === hold.actorId
    );
  }
  const current = (hold: Hold) => store.run((q) => currentSteps(q, hold));
  function* postSignInSteps(
    q: Q,
    hold: Pick<Hold, "sessionId" | "generation" | "actorId" | "fingerprint">,
    link: string,
  ) {
    yield* enqueueOutboxOnceSteps(q, {
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
  function* issueActionSteps(
    q: Q,
    hold: Omit<Hold, "tokenHash" | "linkId" | "linkExpiresAt" | "expiresAt" | "status">,
  ) {
    const link = onboardingLinkId();
    const expiresAt = now() + ONBOARDING_HOLD_MS;
    const inserted = yield* insertWorkspaceAssignmentSteps(q, {
      ...hold,
      tokenHash: workspaceTokenHash(link),
      expiresAt,
      linkId: link,
      linkExpiresAt: expiresAt,
    });
    if (inserted) yield* postSignInSteps(q, hold, link);
  }
  /**
   * Lets a pending hold continue once its creator has a member row that may delegate here,
   * however that row was made: the link, a dashboard sign-in, or a membership sync. Runs inside
   * a write transaction and reads only the database. `queued` says whether it added the job, so
   * the caller wakes the job loop after the commit.
   */
  function* releaseSteps(q: Q, hold: Hold) {
    const held = { released: false, queued: false };
    if (hold.status !== "pending" || expired(hold) || !(yield* currentSteps(q, hold))) return held;
    if ((yield* holdsSteps(q, hold.sessionId))?.tokenHash !== hold.tokenHash) return held;
    const member = yield* workspaceLinearMemberSteps(q, hold.workspaceId, hold.actorId);
    const expected = JSON.parse(hold.fingerprint) as { installation: { teamId: string } };
    if (
      !canAct({ id: hold.actorId, member, teamId: expected.installation.teamId }, "delegate")
        .allowed
    )
      return held;
    yield* moveWorkspaceAssignmentSteps(q, hold.tokenHash, {
      from: "pending",
      to: "ready",
      completedAt: now(),
    });
    const job = yield* enqueueJobOnceSteps(q, {
      queue: QUEUE,
      jobKey: `assignment:${hold.tokenHash}`,
      payload: { sessionId: hold.sessionId, tokenHash: hold.tokenHash },
      now: now(),
    });
    return { released: true, queued: job.inserted };
  }
  /** Holds written before link ids existed get one link and one new-form sign-in action. */
  async function upgrade() {
    const tokens = await store.run((q) =>
      pendingWorkspaceAssignmentTokensSteps(q, { linked: false }),
    );
    for (const tokenHash of tokens)
      await store.transaction(function* (q) {
        const hold = yield* byTokenSteps(q, tokenHash);
        if (!hold || hold.status !== "pending" || hold.linkId !== null) return;
        if (
          (yield* holdsSteps(q, hold.sessionId))?.tokenHash !== tokenHash ||
          !(yield* currentSteps(q, hold))
        )
          return yield* invalidateSteps(q, hold);
        const link = onboardingLinkId();
        const expiresAt = now() + ONBOARDING_HOLD_MS;
        yield* linkWorkspaceAssignmentSteps(q, tokenHash, {
          linkId: link,
          expiresAt,
          tokenHash: workspaceTokenHash(link),
        });
        yield* postSignInSteps(q, hold, link);
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
    const member = () =>
      store.run((q) => workspaceLinearMemberSteps(q, verified.workspaceId, verified.actorId));
    const linked = await member();
    if (linked)
      await store.transaction((q) =>
        syncWorkspaceMemberSteps(q, {
          workspaceId: verified.workspaceId,
          userId: linked.userId,
          active: identity.active && !identity.guest,
          role: "member",
          teamIds: identity.teamIds,
          now: before,
        }),
      );
    // A guest's delegation is ignored; the one line is the session's answer.
    if (identity.guest) return { ...refused(LINEAR_GUEST_REFUSAL), response: true };
    const eligibility = canAct(
      {
        id: verified.actorId,
        identity,
        member: await member(),
        teamId: verified.teamId,
      },
      "delegate",
    );
    // A valid Linear member without a Paws sign-in enters the onboarding hold below.
    return eligibility.allowed || eligibility.signIn
      ? null
      : refused(eligibility.reason, eligibility.response);
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
    if (!(await current(hold))) return refused(STOPPED);
    const installation = await store.run((q) =>
      getLinearSessionInstallationSteps(q, hold.sessionId),
    );
    if (!installation) return UNRECORDED;
    if (installation.oauthClientId !== options.clientId) return refused(ELSEWHERE);
    const workspace = await store.run((q) =>
      workspaceForOrganizationSteps(q, installation.organizationId),
    );
    if (workspace?.id !== hold.workspaceId)
      return refused("This Linear workspace is not connected to Paws.");
    if (
      JSON.stringify({ ...installation, observedAtMs: undefined }) !==
        JSON.stringify(stored.installation) ||
      JSON.stringify(
        await store.run((q) => listWorkspaceRepositoriesSteps(q, hold.workspaceId)),
      ) !== JSON.stringify(stored.repositories)
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
    return (await current(hold)) ? verified : refused(STOPPED);
  }
  /**
   * Ends a hold that may not resume and tells the session why, once. A stopped or replaced
   * session hears nothing: its generation moved on.
   */
  async function refuseHold(hold: Hold, reason: string, response = false) {
    await store.transaction(function* (q) {
      const latest = yield* holdsSteps(q, hold.sessionId);
      if (latest?.tokenHash !== hold.tokenHash || latest.status === "invalid") return;
      yield* invalidateSteps(q, hold);
      if (!(yield* currentSteps(q, hold))) return;
      yield* enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: hold.sessionId,
        generation: hold.generation,
        idempotencyKey: `assignment-refused:${hold.tokenHash}`,
        payload: {
          sessionId: hold.sessionId,
          kind: response ? "response" : "error",
          body: response ? reason : `Paws did not start this work. ${reason}`,
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
  async function keepCreatorReply(event: AcceptedLinearEvent, hold: Hold) {
    if (
      event.action !== "prompted" ||
      !event.sessionId ||
      !event.body?.trim() ||
      !event.actorId ||
      event.actorId !== hold.actorId ||
      hold.status === "invalid" ||
      !(await current(hold))
    )
      return;
    const turn = {
      eventKey: event.dedupeKey,
      activityId: event.activityId,
      sessionId: event.sessionId,
      actorId: event.actorId,
      body: event.body,
      payload: event.payload,
      createdAtMs: event.activityCreatedAtMs ?? event.updatedAtMs,
      now: now(),
    };
    await store.transaction((q) => recordLinearTurnSteps(q, turn));
  }
  function* authorizeIntakeSteps(q: Q, sessionId: string, spec: EpicSnapshot): Steps<boolean> {
    const hold = yield* latestWorkspaceAssignmentSteps(q, sessionId);
    if (!hold) return true;
    if (hold.status !== "accepted" || !(yield* currentSteps(q, hold)))
      return hold.status === "continued";
    const expected = JSON.parse(hold.fingerprint) as {
      spec: EpicSnapshot;
      repositories: unknown;
    };
    const member = yield* workspaceLinearMemberSteps(q, hold.workspaceId, hold.actorId);
    if (
      !canAct({ id: hold.actorId, member, teamId: holdIssue(hold).teamId }, "delegate").allowed ||
      JSON.stringify(spec) !== JSON.stringify(expected.spec) ||
      JSON.stringify(yield* listWorkspaceRepositoriesSteps(q, hold.workspaceId)) !==
        JSON.stringify(expected.repositories)
    ) {
      yield* invalidateWorkspaceAssignmentSteps(q, hold.tokenHash);
      return false;
    }
    return true;
  }
  return {
    authorizeIntake(sessionId: string, spec: EpicSnapshot): boolean {
      return settled(store.run((q) => authorizeIntakeSteps(q, sessionId, spec)));
    },
    authorizeIntakeSteps,
    async authorize(event: AcceptedLinearEvent): Promise<IntakeDecision> {
      if (!event.sessionId) return refused("Paws could not match this event to a session.");
      const sessionId = event.sessionId;
      const session = () => store.run((q) => getLinearSessionSteps(q, sessionId));
      const access = () => store.run((q) => getLinearSessionAccessSteps(q, sessionId));
      let hold = await holds(sessionId);
      if (hold && !(await current(hold))) {
        await invalidate(hold);
        if ((await session())?.generation !== hold.generation) hold = null;
      }
      if (event.signal === "stop") {
        if (hold) await invalidate(hold);
        return ACCEPTED;
      }
      if (event.action !== "created") {
        if (!hold || hold.status === "continued") return ACCEPTED;
        await keepCreatorReply(event, hold);
        return refused(SIGN_IN);
      }
      if (hold) {
        if (!continuations.has(event) || hold.status !== "accepted" || !(await current(hold)))
          return hold.status === "invalid" ? refused(ENDED) : HELD;
        // The job that runs this continuation just re-checked the issue and the membership
        // against the stored snapshot, so this reads only the database.
        const { teamId } = holdIssue(hold);
        const { workspaceId, actorId } = hold;
        const member = await store.run((q) => workspaceLinearMemberSteps(q, workspaceId, actorId));
        const eligibility = canAct({ id: actorId, member, teamId }, "delegate");
        if (!eligibility.allowed) return refused(eligibility.reason, eligibility.response);
        return (await current(hold)) && (await holds(sessionId))?.status === "accepted"
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
      const currentSession = await session();
      if (
        currentSession?.generation !== verified.generation ||
        currentSession.stoppedAt !== null ||
        (await access()) !== "allowed"
      )
        return refused(STOPPED);
      const { workspaceId, actorId } = verified;
      if ((await store.run((q) => workspaceLinearMemberSteps(q, workspaceId, actorId))) !== null)
        return ACCEPTED;
      return store.transaction(function* (q): Steps<IntakeDecision> {
        if ((yield* holdsSteps(q, sessionId))?.generation === verified.generation) return HELD;
        const latest = (yield* getLinearSessionSteps(q, sessionId))!;
        if (
          latest.generation !== verified.generation ||
          latest.stoppedAt !== null ||
          (yield* getLinearSessionAccessSteps(q, sessionId)) !== "allowed"
        )
          return refused(STOPPED);
        yield* issueActionSteps(q, {
          sessionId,
          generation: verified.generation,
          workspaceId,
          actorId,
          fingerprint: verified.fingerprint,
          event: JSON.stringify(event),
        });
        return HELD;
      });
    },
    async recheck(event: AcceptedLinearEvent): Promise<boolean> {
      if (!event.sessionId || event.action !== "created" || event.signal === "stop") return true;
      const sessionId = event.sessionId;
      return (
        (await store.run((q) => getLinearSessionSteps(q, sessionId)))?.stoppedAt === null &&
        (await store.run((q) => getLinearSessionAccessSteps(q, sessionId))) === "allowed"
      );
    },
    /** The issue a hold waits on, for counting its Linear requests. Grants nothing. */
    async issueIdentifier(hash: string): Promise<string | null> {
      const hold = await store.run((q) => byTokenSteps(q, hash));
      return hold ? holdIdentifier(hold) : null;
    },
    /** Resolves an /onboard/<link id> address. The id alone grants nothing. */
    async open(link: string): Promise<AssignmentLink | null> {
      if (!LINK_ID.test(link)) return null;
      const tokenHash = await store.run((q) => workspaceAssignmentTokenForLinkSteps(q, link));
      const hold = tokenHash ? await store.run((q) => currentHoldSteps(q, tokenHash)) : null;
      if (!hold) return null;
      if (hold.status === "pending")
        return !expired(hold) && (await current(hold))
          ? { state: "pending", link, hash: hold.tokenHash }
          : null;
      // A stopped or replaced session ends its onboarding page too.
      if (hold.status === "invalid" || !(await current(hold))) return null;
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
    async complete(
      hash: string,
      workspaceId: string,
      linearUserId: string,
    ): Promise<AssignmentCompletion> {
      const { completion, queued } = await store.transaction(function* (q): Steps<{
        completion: AssignmentCompletion;
        queued: boolean;
      }> {
        const hold = yield* currentHoldSteps(q, hash);
        if (
          !hold ||
          hold.workspaceId !== workspaceId ||
          hold.status === "invalid" ||
          !(yield* currentSteps(q, hold)) ||
          (hold.status === "pending" && expired(hold))
        )
          throw new Error("Assignment sign-in is unavailable.");
        if (hold.actorId !== linearUserId)
          return {
            completion: { outcome: "other-user", creatorName: creatorName(hold) },
            queued: false,
          };
        const release =
          hold.status === "pending"
            ? yield* releaseSteps(q, hold)
            : { released: true, queued: false };
        if (!release.released) throw new Error("Assignment membership is unavailable.");
        return {
          completion: { outcome: "resumed", identifier: holdIdentifier(hold), linkId: hold.linkId },
          queued: release.queued,
        };
      });
      if (queued) emitJobReady(store);
      return completion;
    },
    /** A dashboard sign-in releases the signer's own pending holds without a new action. */
    async releaseFor(workspaceId: string, linearUserId: string): Promise<void> {
      const tokens = await store.run((q) =>
        pendingWorkspaceAssignmentTokensSteps(q, { workspaceId, actorId: linearUserId }),
      );
      for (const tokenHash of tokens) {
        const queued = await store.transaction(function* (q) {
          const hold = yield* byTokenSteps(q, tokenHash);
          return hold ? (yield* releaseSteps(q, hold)).queued : false;
        });
        if (queued) emitJobReady(store);
      }
    },
    /**
     * Registers the sweep and the resume job, then arms the sweep and links old holds. Handlers
     * are registered before it returns, because the job loop starts right after; the returned
     * promise settles when the startup writes are done.
     */
    register(jobs: JobLoop): Promise<void> {
      // Waiting writes nothing to Linear. This sweep ends holds whose session moved on, lets a
      // hold continue once its creator has a member row (for example after signing in from the
      // dashboard instead of the link), and gives a hold past ONBOARDING_HOLD_MS its one final
      // response.
      jobs.register(`${QUEUE}.expire`, async () => {
        await upgrade();
        const tokens = await store.run((q) =>
          pendingWorkspaceAssignmentTokensSteps(q, { linked: true }),
        );
        for (const tokenHash of tokens) {
          const queued = await store.transaction(function* (q) {
            const hold = yield* byTokenSteps(q, tokenHash);
            if (!hold || hold.status !== "pending") return false;
            if (
              (yield* holdsSteps(q, hold.sessionId))?.tokenHash !== tokenHash ||
              !(yield* currentSteps(q, hold))
            ) {
              yield* invalidateSteps(q, hold);
              return false;
            }
            if (expired(hold)) {
              yield* expireSteps(q, hold);
              return false;
            }
            return (yield* releaseSteps(q, hold)).queued;
          });
          if (queued) emitJobReady(store);
        }
      });
      jobs.register(QUEUE, async (job, context) => {
        const payload = job.payload as { sessionId: string; tokenHash: string };
        const hold = await holds(payload.sessionId);
        if (
          !hold ||
          hold.tokenHash !== payload.tokenHash ||
          !["ready", "accepted"].includes(hold.status)
        )
          return;
        const event: AcceptedLinearEvent = JSON.parse(hold.event);
        // Every Linear request of the resume counts toward the issue in the Linear usage ledger.
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
            return refuseHold(hold, verified.reason, verified.response);
          }
          const accepted = await store.transaction(function* (q) {
            if (!context.isCurrent()) throw new Error("Assignment job claim is no longer current.");
            if (
              !(yield* currentSteps(q, hold)) ||
              (yield* holdsSteps(q, hold.sessionId))?.status === "invalid"
            ) {
              yield* invalidateSteps(q, hold);
              return false;
            }
            const member = yield* workspaceLinearMemberSteps(q, hold.workspaceId, hold.actorId);
            if (
              member === null ||
              !canAct({ id: hold.actorId, member, teamId: verified.teamId }, "delegate").allowed
            ) {
              yield* invalidateSteps(q, hold);
              return false;
            }
            if (hold.status === "ready") {
              yield* moveWorkspaceAssignmentSteps(q, hold.tokenHash, {
                from: "ready",
                to: "accepted",
              });
              yield* auditWorkspaceAccessSteps(q, {
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
            await store.run((q) =>
              moveWorkspaceAssignmentSteps(q, hold.tokenHash, {
                from: "accepted",
                to: "continued",
              }),
            );
          } catch (error) {
            // A refusal is final for this hold: say why once instead of retrying the job.
            if (!(error instanceof LinearIntakeRefusedError)) throw error;
            journalCaught(error, "assignments.register.continue", null);
            if (error.quiet) await invalidate(hold);
            else await refuseHold(hold, error.message, error.response);
          } finally {
            continuations.delete(event);
          }
        });
      });
      return (async () => {
        await enqueueJobOnceAsync(store, {
          queue: `${QUEUE}.expire`,
          jobKey: `${QUEUE}.expire`,
          recurringEveryMs: 60_000,
          now: now(),
        });
        await upgrade();
      })();
    },
  };
}

export type WorkspaceAssignments = ReturnType<typeof createWorkspaceAssignments>;
