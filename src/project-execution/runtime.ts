import type { Database } from "bun:sqlite";
import type { CommandBus, RepositoryBinding } from "../core";
import {
  applyWorkItemEvent,
  auditWorkspaceAccess,
  bindWorkItemRepository,
  deliveredLinearIssueState,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getLinearSession,
  getWorkItem,
  immediate,
  listTaskBlockers,
  saveTaskBlocks,
  submitCommand,
  syncWorkspaceMember,
  workspaceForOrganization,
  workspaceLinearMember,
  membershipFresh,
  workspaceMember,
  type JobLoop,
} from "../db";
import {
  linearReadRetry,
  type AcceptedLinearEvent,
  type DependencyEdge,
  type EpicSnapshot,
  type IntakeDecision,
  type LinearIssueLifecycle,
  type LinearMembershipReads,
  type TrackerAdapter,
  type createSessionStarter,
} from "../linear";
import { orderByBlocks, readExternalBlockerEvidence, type IntakeResult } from "../intake";
import { workspaceId } from "../workspace";
import {
  assertProjectAuthority,
  assertProjectTeamAccess,
  createProjectApprovals,
  listProjectApprovals,
  readProjectApproval,
  type ProjectApproval,
} from "./approval";
import { parentSummaryMessage, type SummaryIssue, type SummarySubIssue } from "./parent-summary";
import type { ProjectBlockerPolicy, ProjectPreview } from "./preview";

export const PROJECT_REFUSAL = {
  outcome: "refused" as const,
  reason: "This issue belongs to a Paws project run that continues in its earlier session.",
};
const ACCEPTED: IntakeDecision = { outcome: "accepted" };

type Claim = {
  approvalId: string;
  issueId: string;
  sessionId: string | null;
  epicId: string | null;
};
type Port = {
  pauseItem(itemId: string, canAct?: () => boolean): Promise<boolean>;
  resumeItem(itemId: string, canAct?: () => boolean): Promise<boolean>;
  interruptItem(itemId: string): Promise<void>;
  reconcileExecution(): void;
};

export function createApprovedProjects(input: {
  db: Database;
  tracker: TrackerAdapter;
  lifecycle: Pick<LinearIssueLifecycle, "inspect">;
  memberships: LinearMembershipReads;
  startSession: ReturnType<typeof createSessionStarter>;
  resumeSession: (sessionId: string) => Promise<void>;
  origin: string;
  bus: CommandBus;
  getPort: () => Port | null;
  repository: (name: string) => RepositoryBinding | null;
  saveBlockerPolicies: (input: {
    workspaceId: string;
    itemId: string;
    userId: string;
    policies: readonly ProjectBlockerPolicy[];
  }) => void;
  now?: () => number;
}) {
  const { db } = input;
  const now = input.now ?? Date.now;
  const approvals = createProjectApprovals(input);
  function claims(id: string) {
    return db
      .query<Claim, [string]>(`SELECT approval_id AS approvalId,issue_id AS issueId,
      session_id AS sessionId,delegation_id AS epicId FROM project_approval_issue WHERE approval_id=? ORDER BY issue_id`)
      .all(id);
  }
  function claimForSession(sessionId: string) {
    return db
      .query<Claim, [string]>(`SELECT approval_id AS approvalId,issue_id AS issueId,
      session_id AS sessionId,delegation_id AS epicId FROM project_approval_issue WHERE session_id=?`)
      .get(sessionId);
  }
  function eventClaim(event: AcceptedLinearEvent) {
    if (!event.issueId || !event.sessionId) return null;
    const session = getLinearSession(db, event.sessionId);
    return db
      .query<
        Claim,
        [string, string]
      >(`SELECT c.approval_id AS approvalId,c.issue_id AS issueId,c.session_id AS sessionId,c.delegation_id AS epicId
        FROM project_approval_issue c JOIN workspace w ON w.id=c.workspace_id WHERE c.issue_id=? AND c.released_at IS NULL AND w.linear_organization_id=?`)
      .get(event.issueId, session?.organizationId ?? "");
  }
  function refuse(
    approval: ProjectApproval,
    event: AcceptedLinearEvent,
    reason = PROJECT_REFUSAL.reason,
  ): IntakeDecision {
    auditWorkspaceAccess(db, {
      workspaceId: approval.workspaceId,
      userId: null,
      action: "access.denied",
      subject: `project.event:${event.dedupeKey}`,
      now: now(),
    });
    return { outcome: "refused", reason };
  }
  function steers(approval: ProjectApproval, event: AcceptedLinearEvent, takeover: boolean) {
    const actor = db
      .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
      .get(event.actorId ?? (takeover ? sessionCreator(event.payload) : null) ?? "");
    const member = actor ? workspaceMember(db, approval.workspaceId, actor.id) : null;
    return !!member?.active && member.role !== "observer";
  }
  function authority(approval: ProjectApproval) {
    const result = assertProjectAuthority(
      db,
      { workspaceId: approval.workspaceId, userId: approval.actorId },
      approval.preview,
      approval.source,
    );
    if ([result.member, result.lead].some((member) => !membershipFresh(member, now())))
      throw new Error("Refresh project membership before continuing execution.");
    if (approval.approvedAt === null || approval.pausedAt !== null || approval.stoppedAt !== null)
      throw new Error("Project execution is paused or stopped.");
    return result;
  }
  function scope(sessionId: string, snapshot: EpicSnapshot): EpicSnapshot {
    const claim = claimForSession(sessionId);
    if (!claim) {
      const organizationId = getLinearSession(db, sessionId)?.organizationId;
      if (
        organizationId &&
        db
          .query(`SELECT 1 FROM project_approval_issue c JOIN workspace w ON w.id=c.workspace_id
        WHERE c.issue_id=? AND c.released_at IS NULL AND w.linear_organization_id=?`)
          .get(snapshot.linearIssueId, organizationId)
      )
        throw new Error("This issue already belongs to an approved project scope.");
      return snapshot;
    }
    const approval = readProjectApproval(db, claim.approvalId)!;
    authority(approval);
    if (approval.source === "parent") {
      if (snapshot.linearIssueId !== claim.issueId)
        throw new Error(
          "Approved requirements changed. Stop this scope and approve its current requirements.",
        );
      return { ...snapshot, subIssues: [] };
    }
    const issue = approval.preview.project.issues.find(
      (candidate) => candidate.linearIssueId === claim.issueId,
    )!;
    if (
      snapshot.linearIssueId !== issue.linearIssueId ||
      snapshot.teamId !== issue.teamId ||
      snapshot.projectId !== issue.projectId ||
      snapshot.title !== issue.title ||
      snapshot.description !== issue.description ||
      snapshot.identifier !== issue.identifier ||
      (snapshot.acceptanceCriteria ?? null) !== (issue.acceptanceCriteria ?? null)
    )
      throw new Error(
        "Approved requirements changed. Stop this scope and approve its current requirements.",
      );
    return { ...snapshot, subIssues: [] };
  }
  async function refreshAuthority(
    approval: ProjectApproval,
    signal: AbortSignal,
    unread = (error: unknown): never => {
      throw error;
    },
  ) {
    const workspace = assertProjectAuthority(
      db,
      { workspaceId: approval.workspaceId, userId: approval.actorId },
      approval.preview,
      approval.source,
    ).workspace;
    for (const userId of new Set([approval.actorId, approval.leadUserId])) {
      const member = workspaceMember(db, approval.workspaceId, userId)!;
      const observedAt = now();
      const identity = await input.memberships
        .member(workspace.organizationId, member.linearUserId, signal)
        .catch(unread);
      signal.throwIfAborted();
      if (
        identity.organizationId !== workspace.organizationId ||
        identity.userId !== member.linearUserId
      )
        throw new Error("Linear returned another member.");
      syncWorkspaceMember(db, {
        workspaceId: approval.workspaceId,
        userId,
        active: identity.active,
        role: identity.guest ? "observer" : "member",
        teamIds: identity.teamIds,
        now: observedAt,
      });
    }
    authority(readProjectApproval(db, approval.id)!);
  }
  function restartable(approval: ProjectApproval, claim: Claim): boolean {
    return (
      approval.stoppedAt === null &&
      claim.epicId !== null &&
      db
        .query(
          "SELECT 1 FROM work_item WHERE delegation_id=? AND state NOT IN ('failed','cancelled')",
        )
        .get(claim.epicId) === null
    );
  }
  function canDispatch(epicId: string): boolean {
    const claim = db
      .query<{ approvalId: string; issueId: string }, [string]>(
        "SELECT approval_id AS approvalId,issue_id AS issueId FROM project_approval_issue WHERE delegation_id=?",
      )
      .get(epicId);
    if (!claim) return true;
    try {
      const approval = readProjectApproval(db, claim.approvalId)!;
      authority(approval);
      for (const edge of approval.preview.edges) {
        if (
          edge.blockedLinearIssueId !== claim.issueId ||
          !approval.preview.includedIssueIds.includes(edge.blockerLinearIssueId)
        )
          continue;
        if (
          !db
            .query(`SELECT 1 FROM project_approval_issue c JOIN work_item i ON i.delegation_id=c.delegation_id
          LEFT JOIN work_item_task t ON t.item_id=i.id WHERE c.approval_id=? AND c.issue_id=?
          AND i.linear_issue_id=c.issue_id AND i.cancel_requested=0
          AND (i.state='merged' OR (i.state='completed' AND t.mode IN ('answer','artifact')))`)
            .get(claim.approvalId, edge.blockerLinearIssueId)
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  /**
   * End an adopted parent's own session with one response once its sub-issue sessions
   * are open: each sub-issue, whether it started, and the unfinished issues it waits for.
   */
  async function summarizeParent(approval: ProjectApproval, signal: AbortSignal) {
    const prefix = "parent:";
    if (approval.source !== "parent" || !approval.generation.startsWith(prefix)) return;
    const sessionId = approval.generation.slice(prefix.length);
    const key = `parent-summary:${approval.id}`;
    if (db.query("SELECT 1 FROM outbox WHERE idempotency_key=?").get(key)) return;
    const { preview } = approval;
    const issues = new Map(preview.project.issues.map((issue) => [issue.linearIssueId, issue]));
    const finished = new Set(
      db
        .query<{ issueId: string }, [string]>(
          `SELECT c.issue_id AS issueId FROM project_approval_issue c JOIN work_item i
           ON i.delegation_id=c.delegation_id AND i.linear_issue_id=c.issue_id
           WHERE c.approval_id=? AND i.state IN ('merged','completed')`,
        )
        .all(approval.id)
        .map((row) => row.issueId),
    );
    const outside = new Map<string, SummaryIssue | null>();
    const subIssues: SummarySubIssue[] = [];
    for (const issueId of preview.order) {
      const issue = issues.get(issueId);
      if (!issue) continue;
      const blockers: SummaryIssue[] = [];
      for (const edge of preview.edges) {
        if (edge.blockedLinearIssueId !== issueId || finished.has(edge.blockerLinearIssueId))
          continue;
        const blocker = issues.get(edge.blockerLinearIssueId);
        if (blocker) blockers.push({ identifier: blocker.identifier, url: blocker.url ?? null });
      }
      const external: SummaryIssue[] = [];
      for (const edge of await input.tracker.listDeps(issueId)) {
        const blockerId = edge.blockerLinearIssueId;
        if (edge.blockedLinearIssueId !== issueId || issues.has(blockerId)) continue;
        if (!outside.has(blockerId)) {
          const read = await input.lifecycle.inspect(blockerId, { signal });
          outside.set(
            blockerId,
            ["completed", "canceled"].includes(read.stateType)
              ? null
              : { identifier: read.identifier ?? blockerId, url: read.url ?? null },
          );
        }
        const blocker = outside.get(blockerId);
        if (blocker && !external.some((entry) => entry.identifier === blocker.identifier))
          external.push(blocker);
      }
      signal.throwIfAborted();
      external.sort((left, right) => left.identifier.localeCompare(right.identifier));
      subIssues.push({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url ?? null,
        blockers: [...blockers, ...external],
      });
    }
    if (!subIssues.length) return;
    db.transaction(() => {
      const current = readProjectApproval(db, approval.id);
      if (!current || current.stoppedAt !== null) return;
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: sessionId,
        idempotencyKey: key,
        payload: {
          sessionId,
          kind: "response",
          body: parentSummaryMessage(subIssues),
          id: crypto.randomUUID(),
        },
        now: now(),
      });
    }).immediate();
  }
  function identifierFor(approval: ProjectApproval, issueId: string): string {
    return (
      approval.preview.project.issues.find((issue) => issue.linearIssueId === issueId)
        ?.identifier ??
      db
        .query<{ identifier: string }, [string]>(
          "SELECT linear_identifier AS identifier FROM work_item WHERE linear_issue_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .get(issueId)?.identifier ??
      deliveredLinearIssueState(db, approval.preview.project.organizationId, issueId)?.identifier ??
      issueId
    );
  }
  /**
   * Whether a blocker lets its dependent's session open, from stored state only. A blocker with
   * live Paws tasks follows its latest task. Otherwise (PAS-514) it follows its last delivered
   * Linear state, and with none delivered it holds only while a project still claims it; the
   * task's own dependency check reads Linear once its session is open.
   */
  function blockerSatisfied(approval: ProjectApproval, blockerId: string): boolean {
    const items = db
      .query<{ state: string; mode: string | null; cancelRequested: number }, [string, string]>(
        `SELECT i.state,t.mode,i.cancel_requested AS cancelRequested FROM work_item i
         JOIN linear_session s ON s.session_id=i.session_key
         JOIN workspace w ON w.linear_organization_id=s.organization_id
         LEFT JOIN work_item_task t ON t.item_id=i.id
         WHERE w.id=? AND i.linear_issue_id=? AND i.state<>'cancelled'
         AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
         ORDER BY i.created_at,i.id`,
      )
      .all(approval.workspaceId, blockerId);
    if (items.length > 0) {
      const active = items.filter((item) => !item.cancelRequested);
      const item = (active.length > 0 ? active : items).at(-1)!;
      return (
        !item.cancelRequested &&
        (item.state === "merged" ||
          (item.state === "completed" && (item.mode === "answer" || item.mode === "artifact")))
      );
    }
    if (
      approval.preview.selection.blockers?.some(
        (policy) => policy.blockerLinearIssueId === blockerId && policy.outcome === "merge",
      )
    )
      return true;
    const delivered = deliveredLinearIssueState(
      db,
      approval.preview.project.organizationId,
      blockerId,
    );
    if (delivered?.stateType) return delivered.stateType === "completed";
    return (
      db
        .query(
          "SELECT 1 FROM project_approval_issue WHERE workspace_id=? AND issue_id=? AND released_at IS NULL",
        )
        .get(approval.workspaceId, blockerId) === null
    );
  }
  /** Identifiers of the blockers that still hold a claim's session. */
  function waitingFor(approval: ProjectApproval, issueId: string): string[] {
    const blockers = new Set([
      ...approval.preview.edges
        .filter((edge) => edge.blockedLinearIssueId === issueId)
        .map((edge) => edge.blockerLinearIssueId),
      ...listTaskBlockers(db, issueId),
    ]);
    return [...blockers]
      .filter((blockerId) => !blockerSatisfied(approval, blockerId))
      .map((blockerId) => identifierFor(approval, blockerId))
      .sort();
  }
  function adoptParent(
    sessionId: string,
    snapshot: EpicSnapshot,
    edges: readonly DependencyEdge[],
  ): boolean {
    const session = getLinearSession(db, sessionId);
    if (!session?.organizationId || !session.creatorId) return false;
    const workspace = workspaceForOrganization(db, session.organizationId);
    if (!workspace) return false;
    if (
      db
        .query(
          "SELECT 1 FROM project_approval WHERE workspace_id=? AND source='parent' AND project_id=? AND stopped_at IS NULL",
        )
        .get(workspace.id, snapshot.linearIssueId) !== null
    )
      return true;
    const owner = workspaceLinearMember(db, workspace.id, session.creatorId);
    if (!owner?.active || owner.role === "observer") return false;
    const issueIds = snapshot.subIssues.map((issue) => issue.linearIssueId);
    if (
      issueIds.some(
        (issueId) =>
          db
            .query(
              "SELECT 1 FROM project_approval_issue WHERE workspace_id=? AND issue_id=? AND released_at IS NULL",
            )
            .get(workspace.id, issueId) !== null ||
          db
            .query(`SELECT 1 FROM work_item i JOIN linear_session s ON s.session_id=i.session_key
              JOIN workspace w ON w.linear_organization_id=s.organization_id
              WHERE w.id=? AND i.linear_issue_id=? AND i.state NOT IN ('completed','merged','cancelled') LIMIT 1`)
            .get(workspace.id, issueId) !== null,
      )
    )
      return false;
    const subIds = new Set(issueIds);
    const internal = edges.filter(
      (edge) => subIds.has(edge.blockerLinearIssueId) && subIds.has(edge.blockedLinearIssueId),
    );
    const ordered = orderByBlocks(
      snapshot.subIssues.map((issue) => ({
        linearIssueId: issue.linearIssueId,
        identifier: issue.identifier,
        title: issue.title,
      })),
      internal,
    );
    if (!ordered.ok) return false;
    const createdAt = now();
    const id = workspaceId(createdAt);
    const generation = `parent:${sessionId}`;
    const updatedAt = new Date(createdAt).toISOString();
    const preview: ProjectPreview = {
      selection: {
        projectId: snapshot.linearIssueId,
        issueIds,
        repository: "",
        targetBranch: "main",
        leadUserId: owner.userId,
        steeringRoles: ["admin", "member", "owner"],
        blockers: [],
      },
      project: {
        id: snapshot.linearIssueId,
        name: snapshot.title,
        organizationId: workspace.organizationId,
        updatedAt,
        leadId: null,
        issues: snapshot.subIssues.map((issue) => ({
          ...issue,
          description: issue.description ?? null,
          acceptanceCriteria: issue.acceptanceCriteria ?? null,
          teamId: issue.teamId ?? snapshot.teamId ?? "",
          projectId: issue.projectId || "",
          parentId: snapshot.linearIssueId,
          stateType: "unstarted",
          updatedAt,
        })),
      },
      generation,
      includedIssueIds: issueIds,
      excludedIssueIds: [],
      order: ordered.ordered.map((issue) => issue.linearIssueId),
      edges: internal,
      externalBlockerIds: [],
      problems: [],
    };
    db.run(
      `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at,source)
       VALUES(?,?,?,?,?,?,?,?,?,?,'parent')`,
      [
        id,
        workspace.id,
        snapshot.linearIssueId,
        owner.userId,
        owner.userId,
        generation,
        JSON.stringify(preview),
        createdAt,
        createdAt,
        createdAt,
      ],
    );
    for (const issueId of issueIds)
      db.run(
        "INSERT INTO project_approval_issue(workspace_id,issue_id,approval_id) VALUES(?,?,?)",
        [workspace.id, issueId, id],
      );
    saveTaskBlocks(
      db,
      issueIds,
      edges.filter((edge) => subIds.has(edge.blockedLinearIssueId)),
    );
    auditWorkspaceAccess(db, {
      workspaceId: workspace.id,
      userId: owner.userId,
      action: "project.approved",
      subject: `${id}:${generation}`,
      now: createdAt,
    });
    return true;
  }
  return {
    ...approvals,
    adoptParent,
    list: (id: string) => listProjectApprovals(db, id),
    progress(id: string) {
      const approval = readProjectApproval(db, id);
      return claims(id).map((claim) => ({
        ...claim,
        waitingFor: approval && !claim.sessionId ? waitingFor(approval, claim.issueId) : [],
        blockedReasons:
          claim.epicId && approval
            ? [
                ...Object.entries(
                  readExternalBlockerEvidence(db, {
                    workspaceId: approval.workspaceId,
                    delegationId: claim.epicId,
                  }),
                ).flatMap(([issueId, evidence]) =>
                  evidence.satisfied ? [] : [`${issueId}: ${evidence.reason}`],
                ),
                ...(canDispatch(claim.epicId)
                  ? []
                  : ["Waiting for approved dependencies, project controls or refreshed access."]),
              ]
            : [],
        items: claim.epicId
          ? db
              .query<{ id: string; state: string; title: string }, [string]>(
                "SELECT id,state,title FROM work_item WHERE delegation_id=? ORDER BY position",
              )
              .all(claim.epicId)
          : [],
      }));
    },
    canDispatch,
    scope,
    authorizeIntake(sessionId: string, snapshot: EpicSnapshot) {
      try {
        scope(sessionId, snapshot);
        return true;
      } catch {
        return false;
      }
    },
    actor(sessionId: string) {
      const claim = claimForSession(sessionId);
      if (!claim) return undefined;
      return authority(readProjectApproval(db, claim.approvalId)!).lead.linearUserId;
    },
    accepted(sessionId: string, result: IntakeResult) {
      const claim = claimForSession(sessionId);
      if (!claim) return;
      const approval = readProjectApproval(db, claim.approvalId)!;
      authority(approval);
      if (
        !result.ok ||
        result.items.length !== 1 ||
        result.items[0]?.linearIssueId !== claim.issueId
      )
        throw new Error("Canonical intake did not preserve the approved issue scope.");
      const item = result.items[0];
      if (approval.source !== "parent") {
        const repository = input.repository(approval.preview.selection.repository);
        if (!repository || approval.preview.selection.targetBranch !== "main")
          throw new Error("The approved repository and main branch must be configured.");
        bindWorkItemRepository(db, item.id, repository);
      }
      db.run("UPDATE work_item SET project_approval_id=?, owner_user_id=? WHERE id=?", [
        approval.id,
        approval.actorId,
        item.id,
      ]);
      db.run("UPDATE project_approval_issue SET delegation_id=? WHERE session_id=?", [
        result.delegation.id,
        sessionId,
      ]);
      if (approval.source === "parent") return;
      input.saveBlockerPolicies({
        workspaceId: approval.workspaceId,
        itemId: item.id,
        userId: approval.actorId,
        policies: (approval.preview.selection.blockers ?? []).filter((policy) =>
          approval.preview.edges.some(
            (edge) =>
              edge.blockerLinearIssueId === policy.blockerLinearIssueId &&
              edge.blockedLinearIssueId === claim.issueId,
          ),
        ),
      });
    },
    async authorizeEvent(event: AcceptedLinearEvent): Promise<IntakeDecision | undefined> {
      const claim = eventClaim(event);
      if (!claim) return undefined;
      const approval = readProjectApproval(db, claim.approvalId)!;
      const takeover = claim.sessionId !== event.sessionId;
      if (takeover && (event.action !== "created" || !restartable(approval, claim))) {
        if (event.action !== "created" || approval.stoppedAt !== null)
          return refuse(approval, event);
        const identifier =
          approval.preview.project.issues.find((issue) => issue.linearIssueId === claim.issueId)
            ?.identifier ?? "This issue";
        return refuse(
          approval,
          event,
          `${identifier} is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.`,
        );
      }
      const read: { failure?: unknown } = {};
      try {
        if (
          (takeover || event.action === "prompted" || event.signal === "stop") &&
          !steers(approval, event, takeover)
        )
          return refuse(approval, event);
        if (event.signal === "stop") return ACCEPTED;
        await refreshAuthority(approval, AbortSignal.timeout(30_000), (error) => {
          read.failure = error;
          throw error;
        });
        if (takeover) {
          const moved = immediate(db, () => {
            if (!restartable(approval, claim)) return false;
            for (const item of db
              .query<{ id: string }, [string]>(
                "SELECT id FROM work_item WHERE delegation_id=? AND state='failed'",
              )
              .all(claim.epicId!))
              applyWorkItemEvent(db, item.id, "cancel");
            db.run(
              "UPDATE project_approval_issue SET session_id=?,delegation_id=NULL WHERE approval_id=? AND issue_id=? AND session_id=?",
              [event.sessionId, claim.approvalId, claim.issueId, claim.sessionId],
            );
            return true;
          });
          if (!moved) return refuse(approval, event);
        }
        return ACCEPTED;
      } catch {
        return "failure" in read ? linearReadRetry(read.failure) : refuse(approval, event);
      }
    },
    recheckEvent(event: AcceptedLinearEvent): boolean | undefined {
      const claim = eventClaim(event);
      if (!claim) return undefined;
      const approval = readProjectApproval(db, claim.approvalId)!;
      if (
        claim.sessionId === event.sessionId &&
        ((event.action !== "prompted" && event.signal !== "stop") || steers(approval, event, false))
      )
        return true;
      refuse(approval, event);
      return false;
    },
    async scopeSnapshot(sessionId: string, snapshot: EpicSnapshot, signal?: AbortSignal) {
      const claim = claimForSession(sessionId);
      if (!claim) return snapshot;
      const approval = readProjectApproval(db, claim.approvalId)!;
      await refreshAuthority(approval, signal ?? AbortSignal.timeout(30_000));
      if (approval.source === "parent") return scope(sessionId, snapshot);
      const expected = approval.preview.edges.filter(
        (edge) => edge.blockedLinearIssueId === claim.issueId,
      );
      const actual = (await input.tracker.listDeps(claim.issueId)).filter(
        (edge) => edge.blockedLinearIssueId === claim.issueId,
      );
      signal?.throwIfAborted();
      const key = (edges: typeof actual) =>
        JSON.stringify(
          edges.map((edge) => `${edge.blockerLinearIssueId}:${edge.blockedLinearIssueId}`).sort(),
        );
      if (key(expected) !== key(actual))
        throw new Error(
          "Approved dependencies changed. Stop this scope and approve its current dependencies.",
        );
      return scope(sessionId, snapshot);
    },
    async control(
      actor: { workspaceId: string; userId: string },
      id: string,
      action: "pause" | "resume" | "stop",
    ) {
      const saved = readProjectApproval(db, id);
      const member = workspaceMember(db, actor.workspaceId, actor.userId);
      if (
        !saved ||
        saved.workspaceId !== actor.workspaceId ||
        !member?.active ||
        member.role === "observer"
      ) {
        auditWorkspaceAccess(db, {
          ...actor,
          action: "access.denied",
          subject: `project.${action}:${id}`,
          now: now(),
        });
        throw new Error("Project steering access is required.");
      }
      const authorize = (approval: ProjectApproval) => {
        try {
          return action === "resume"
            ? assertProjectAuthority(db, actor, approval.preview, approval.source).member
            : assertProjectTeamAccess(db, actor, approval.preview).member;
        } catch (error) {
          auditWorkspaceAccess(db, {
            ...actor,
            action: "access.denied",
            subject: `project.${action}:${id}`,
            now: now(),
          });
          throw error;
        }
      };
      authorize(saved);
      const port = input.getPort();
      if (!port) throw new Error("Project execution controls are not ready.");
      const canAct = () => {
        try {
          const current = readProjectApproval(db, id)!;
          const currentMember = authorize(current);
          return (
            current.stoppedAt === null &&
            currentMember.role !== "observer" &&
            (action === "pause" ? current.pausedAt !== null : current.pausedAt === null)
          );
        } catch {
          return false;
        }
      };
      const currentClaims = claims(id);
      db.transaction(() => {
        const current = readProjectApproval(db, id)!;
        authorize(current);
        if (
          current.approvedAt === null ||
          (current.stoppedAt !== null && action !== "stop") ||
          (action === "pause" && current.pausedAt !== null) ||
          (action === "resume" && current.pausedAt === null)
        )
          throw new Error("This project action is no longer available.");
        db.run(
          `UPDATE project_approval SET ${action === "stop" ? "stopped_at" : "paused_at"}=? WHERE id=?`,
          [action === "resume" ? null : now(), id],
        );
        auditWorkspaceAccess(db, {
          ...actor,
          action: `project.${action}`,
          subject: id,
          now: now(),
        });
        if (action === "stop")
          for (const claim of currentClaims) {
            if (!claim.epicId) continue;
            for (const item of db
              .query<{ id: string }, [string]>(
                "SELECT id FROM work_item WHERE delegation_id=? AND state NOT IN ('merged','completed','cancelled')",
              )
              .all(claim.epicId))
              submitCommand(db, input.bus, {
                type: "stop",
                itemId: item.id,
                source: "dashboard",
                requestedAt: now(),
              });
          }
      }).immediate();
      for (const claim of currentClaims) {
        if (!claim.epicId) continue;
        for (const item of db
          .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE delegation_id=?")
          .all(claim.epicId)) {
          if (action === "stop") await port.interruptItem(item.id);
          else if (action === "pause" && getWorkItem(db, item.id)?.state === "running")
            await port.pauseItem(item.id, canAct);
          else if (action === "resume" && getWorkItem(db, item.id)?.state === "paused")
            await port.resumeItem(item.id, canAct);
        }
      }
      if (action === "stop")
        db.run(
          "UPDATE project_approval_issue SET released_at=? WHERE approval_id=? AND released_at IS NULL",
          [now(), id],
        );
      port.reconcileExecution();
    },
    register(jobs: JobLoop) {
      enqueueJobOnce(db, {
        queue: "project.approvals",
        jobKey: "project.approvals",
        recurringEveryMs: 30_000,
        now: now(),
      });
      jobs.register("project.approvals", async (_job, context) => {
        const rows = db
          .query<{ id: string }, []>(
            "SELECT id FROM project_approval WHERE approved_at IS NOT NULL AND paused_at IS NULL AND stopped_at IS NULL ORDER BY approved_at",
          )
          .all();
        for (const row of rows) {
          context.signal.throwIfAborted();
          try {
            const approval = readProjectApproval(db, row.id)!;
            const current = claims(row.id);
            const ready = new Set(
              current
                .filter(
                  (claim) => !claim.sessionId && waitingFor(approval, claim.issueId).length === 0,
                )
                .map((claim) => claim.issueId),
            );
            const idle = ready.size === 0 && current.every((claim) => !claim.sessionId);
            if (!idle) {
              const stale = [approval.actorId, approval.leadUserId].some((userId) => {
                const member = workspaceMember(db, approval.workspaceId, userId);
                return member === null || !membershipFresh(member, now());
              });
              if (stale) await refreshAuthority(approval, context.signal);
              else authority(approval);
            }
            for (const claim of idle ? [] : current) {
              if (claim.sessionId) {
                if (!claim.epicId) await input.resumeSession(claim.sessionId);
                continue;
              }
              if (!ready.has(claim.issueId)) continue;
              await input.startSession(
                { kind: "issue", id: claim.issueId },
                new URL("/status/", input.origin).href,
                context.signal,
                (event) => {
                  if (!context.isCurrent()) throw new Error("The project dispatch claim changed.");
                  authority(readProjectApproval(db, row.id)!);
                  if (event.issueId !== claim.issueId || !event.sessionId)
                    throw new Error("Linear returned another project issue.");
                  const changed = db.run(
                    "UPDATE project_approval_issue SET session_id=? WHERE approval_id=? AND issue_id=? AND session_id IS NULL",
                    [event.sessionId, row.id, claim.issueId],
                  ).changes;
                  if (changed !== 1)
                    throw new Error("This project issue already has a canonical session.");
                },
              );
            }
            await summarizeParent(readProjectApproval(db, row.id)!, context.signal);
            db.run("UPDATE project_approval SET last_error=NULL WHERE id=?", [row.id]);
          } catch {
            context.signal.throwIfAborted();
            db.run("UPDATE project_approval SET last_error=? WHERE id=?", [
              "Project delivery could not be refreshed. Check Linear access and refresh this project.",
              row.id,
            ]);
          }
        }
      });
    },
  };
}

function sessionCreator(payload: string): string | null {
  try {
    const creator = (JSON.parse(payload) as { agentSession?: { creatorId?: unknown } }).agentSession
      ?.creatorId;
    return typeof creator === "string" ? creator : null;
  } catch {
    return null;
  }
}
