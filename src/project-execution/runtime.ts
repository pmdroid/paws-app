import type { Database } from "bun:sqlite";
import type { CommandBus, RepositoryBinding } from "../core";
import {
  auditWorkspaceAccess,
  bindWorkItemRepository,
  enqueueJobOnce,
  getLinearSession,
  getWorkItem,
  submitCommand,
  syncWorkspaceMember,
  workspaceMember,
  type JobLoop,
} from "../db";
import type {
  AcceptedLinearEvent,
  EpicSnapshot,
  LinearMembershipReads,
  TrackerAdapter,
  createSessionStarter,
} from "../linear";
import { readExternalBlockerEvidence, type IntakeResult } from "../intake";
import {
  assertProjectAuthority,
  assertProjectTeamAccess,
  createProjectApprovals,
  listProjectApprovals,
  readProjectApproval,
  type ProjectApproval,
} from "./approval";
import type { ProjectBlockerPolicy } from "./preview";

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
  memberships: LinearMembershipReads;
  startSession: ReturnType<typeof createSessionStarter>;
  resumeSession: (sessionId: string) => Promise<void>;
  origin: string;
  bus: CommandBus;
  getPort: () => Port | null;
  repository: (name: string) => RepositoryBinding | null;
  saveBlockerPolicies: (input: {
    workspaceId: string;
    epicId: string;
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
      session_id AS sessionId,epic_id AS epicId FROM project_approval_issue WHERE approval_id=? ORDER BY issue_id`)
      .all(id);
  }
  function claimForSession(sessionId: string) {
    return db
      .query<Claim, [string]>(`SELECT approval_id AS approvalId,issue_id AS issueId,
      session_id AS sessionId,epic_id AS epicId FROM project_approval_issue WHERE session_id=?`)
      .get(sessionId);
  }
  function authority(approval: ProjectApproval) {
    const result = assertProjectAuthority(
      db,
      { workspaceId: approval.workspaceId, userId: approval.actorId },
      approval.preview,
    );
    if (
      [result.member, result.lead].some(
        (member) => member.checkedAt > now() || now() - member.checkedAt > 300_000,
      )
    )
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
  async function refreshAuthority(approval: ProjectApproval, signal: AbortSignal) {
    const workspace = assertProjectAuthority(
      db,
      { workspaceId: approval.workspaceId, userId: approval.actorId },
      approval.preview,
    ).workspace;
    for (const userId of new Set([approval.actorId, approval.leadUserId])) {
      const member = workspaceMember(db, approval.workspaceId, userId)!;
      const observedAt = now();
      const identity = await input.memberships.member(
        workspace.organizationId,
        member.linearUserId,
        signal,
      );
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
  function canDispatch(epicId: string): boolean {
    const claim = db
      .query<{ approvalId: string; issueId: string }, [string]>(
        "SELECT approval_id AS approvalId,issue_id AS issueId FROM project_approval_issue WHERE epic_id=?",
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
            .query(`SELECT 1 FROM project_approval_issue c JOIN work_item i ON i.epic_id=c.epic_id
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
  return {
    ...approvals,
    list: (workspaceId: string) => listProjectApprovals(db, workspaceId),
    progress(id: string) {
      const approval = readProjectApproval(db, id);
      return claims(id).map((claim) => ({
        ...claim,
        blockedReasons:
          claim.epicId && approval
            ? [
                ...Object.entries(
                  readExternalBlockerEvidence(db, {
                    workspaceId: approval.workspaceId,
                    epicId: claim.epicId,
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
                "SELECT id,state,title FROM work_item WHERE epic_id=? ORDER BY position",
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
      const repository = input.repository(approval.preview.selection.repository);
      if (!repository || approval.preview.selection.targetBranch !== "main")
        throw new Error("The approved repository and main branch must be configured.");
      bindWorkItemRepository(db, result.items[0].id, repository);
      db.run("UPDATE project_approval_issue SET epic_id=? WHERE session_id=?", [
        result.epic.id,
        sessionId,
      ]);
      input.saveBlockerPolicies({
        workspaceId: approval.workspaceId,
        epicId: result.epic.id,
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
    async authorizeEvent(event: AcceptedLinearEvent): Promise<boolean | undefined> {
      if (!event.issueId || !event.sessionId) return undefined;
      const session = getLinearSession(db, event.sessionId);
      const claim = db
        .query<
          Claim,
          [string, string]
        >(`SELECT c.approval_id AS approvalId,c.issue_id AS issueId,c.session_id AS sessionId,c.epic_id AS epicId
        FROM project_approval_issue c JOIN workspace w ON w.id=c.workspace_id WHERE c.issue_id=? AND c.released_at IS NULL AND w.linear_organization_id=?`)
        .get(event.issueId, session?.organizationId ?? "");
      if (!claim) return undefined;
      const approval = readProjectApproval(db, claim.approvalId)!;
      const deny = () => {
        auditWorkspaceAccess(db, {
          workspaceId: approval.workspaceId,
          userId: null,
          action: "access.denied",
          subject: `project.event:${event.dedupeKey}`,
          now: now(),
        });
        return false;
      };
      if (claim.sessionId !== event.sessionId) return deny();
      try {
        if (event.action === "prompted" || event.signal === "stop") {
          const actor = db
            .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
            .get(event.actorId ?? "");
          const member = actor ? workspaceMember(db, approval.workspaceId, actor.id) : null;
          if (
            !member?.active ||
            member.role === "observer" ||
            (member.userId !== approval.leadUserId &&
              !approval.preview.selection.steeringRoles.includes(member.role))
          )
            return deny();
        }
        if (event.signal === "stop") return true;
        await refreshAuthority(approval, AbortSignal.timeout(30_000));
        return true;
      } catch {
        return deny();
      }
    },
    async scopeSnapshot(sessionId: string, snapshot: EpicSnapshot, signal?: AbortSignal) {
      const claim = claimForSession(sessionId);
      if (!claim) return snapshot;
      const approval = readProjectApproval(db, claim.approvalId)!;
      await refreshAuthority(approval, signal ?? AbortSignal.timeout(30_000));
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
        member.role === "observer" ||
        (actor.userId !== saved.leadUserId &&
          !saved.preview.selection.steeringRoles.includes(member.role))
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
            ? assertProjectAuthority(db, actor, approval.preview).member
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
            (actor.userId === current.leadUserId ||
              current.preview.selection.steeringRoles.includes(currentMember.role)) &&
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
                "SELECT id FROM work_item WHERE epic_id=? AND state NOT IN ('merged','completed','cancelled')",
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
          .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE epic_id=?")
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
            await refreshAuthority(approval, context.signal);
            for (const claim of claims(row.id)) {
              if (claim.sessionId) {
                if (!claim.epicId) await input.resumeSession(claim.sessionId);
                continue;
              }
              await input.startSession(
                { kind: "issue", id: claim.issueId },
                new URL("/status/#/projects", input.origin).href,
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
