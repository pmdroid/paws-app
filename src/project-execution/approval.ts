import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  getWorkspace,
  listWorkspaceRepositories,
  syncWorkspaceMember,
  workspaceMember,
} from "../db";
import type { LinearMembershipReads, TrackerAdapter } from "../linear";
import { workspaceId } from "../workspace";
import { previewProject, type ProjectPreview, type ProjectSelection } from "./preview";

export type ProjectApproval = {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  leadUserId: string;
  generation: string;
  preview: ProjectPreview;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  pausedAt: number | null;
  stoppedAt: number | null;
  lastError: string | null;
};

type Actor = { workspaceId: string; userId: string };
type ApprovalRow = Omit<ProjectApproval, "preview"> & { preview: string };
const SELECT = `SELECT id,workspace_id AS workspaceId,project_id AS projectId,
 actor_id AS actorId,lead_user_id AS leadUserId,generation,preview,created_at AS createdAt,
 expires_at AS expiresAt,approved_at AS approvedAt,paused_at AS pausedAt,stopped_at AS stoppedAt,last_error AS lastError
 FROM project_approval`;

export function readProjectApproval(db: Database, id: string): ProjectApproval | null {
  const row = db.query<ApprovalRow, [string]>(`${SELECT} WHERE id=?`).get(id);
  return row ? { ...row, preview: JSON.parse(row.preview) } : null;
}

export function listProjectApprovals(db: Database, workspace: string): ProjectApproval[] {
  return db
    .query<ApprovalRow, [string]>(
      `${SELECT} WHERE workspace_id=? AND approved_at IS NOT NULL ORDER BY created_at DESC`,
    )
    .all(workspace)
    .map((row) => ({ ...row, preview: JSON.parse(row.preview) }));
}

export function assertProjectAuthority(db: Database, actor: Actor, preview: ProjectPreview) {
  const member = workspaceMember(db, actor.workspaceId, actor.userId);
  const lead = workspaceMember(db, actor.workspaceId, preview.selection.leadUserId);
  const workspace = getWorkspace(db, actor.workspaceId);
  const mappings = listWorkspaceRepositories(db, actor.workspaceId);
  if (
    !member?.active ||
    member.role === "observer" ||
    !lead?.active ||
    lead.role === "observer" ||
    workspace?.organizationId !== preview.project.organizationId
  )
    throw new Error("Current workspace membership and an active lead are required.");
  const ids = new Set(preview.includedIssueIds);
  for (const issue of preview.project.issues.filter((candidate) =>
    ids.has(candidate.linearIssueId),
  )) {
    const repositories = [
      preview.selection.repository,
      ...(preview.selection.blockers ?? []).flatMap((policy) =>
        policy.outcome === "merge" &&
        preview.edges.some(
          (edge) =>
            edge.blockedLinearIssueId === issue.linearIssueId &&
            edge.blockerLinearIssueId === policy.blockerLinearIssueId,
        )
          ? [policy.repository]
          : [],
      ),
    ];
    if (
      !member.teamIds.includes(issue.teamId) ||
      !lead.teamIds.includes(issue.teamId) ||
      repositories.some(
        (repository) =>
          !mappings.some(
            (mapping) =>
              mapping.teamId === issue.teamId &&
              mapping.repository.toLowerCase() === repository.toLowerCase(),
          ),
      )
    )
      throw new Error("The selected issues, lead and repository must share authorized teams.");
  }
  return { member, lead, workspace };
}

export function createProjectApprovals(input: {
  db: Database;
  tracker: Pick<TrackerAdapter, "loadProject" | "listDeps">;
  memberships: LinearMembershipReads;
  repository?: (name: string) => unknown;
  now?: () => number;
}) {
  const { db } = input;
  const now = input.now ?? Date.now;
  async function refresh(actor: Actor, userIds: readonly string[], signal: AbortSignal) {
    const workspace = getWorkspace(db, actor.workspaceId);
    if (!workspace) throw new Error("This workspace is not installed.");
    for (const userId of new Set([actor.userId, ...userIds])) {
      const member = workspaceMember(db, actor.workspaceId, userId);
      if (!member?.active || member.role === "observer")
        throw new Error("An active workspace member is required.");
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
        workspaceId: actor.workspaceId,
        userId,
        active: identity.active,
        role: identity.guest ? "observer" : "member",
        teamIds: identity.teamIds,
        now: observedAt,
      });
    }
    return workspace;
  }
  function denied(actor: Actor, subject: string) {
    auditWorkspaceAccess(db, { ...actor, action: "access.denied", subject, now: now() });
  }
  return {
    async preview(
      actor: Actor,
      selection: ProjectSelection,
      signal: AbortSignal,
    ): Promise<ProjectApproval> {
      try {
        const workspace = await refresh(actor, [selection.leadUserId], signal);
        const preview = await previewProject(input.tracker, selection, {
          organizationId: workspace.organizationId,
          signal,
        });
        signal.throwIfAborted();
        return db
          .transaction(() => {
            assertProjectAuthority(db, actor, preview);
            if (input.repository && !input.repository(preview.selection.repository))
              throw new Error("Configure the selected repository before approving its issues.");
            const createdAt = now();
            const id = workspaceId(createdAt);
            db.run(
              `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,actor_id,generation) WHERE stopped_at IS NULL DO UPDATE SET
            expires_at=excluded.expires_at WHERE project_approval.approved_at IS NULL`,
              [
                id,
                actor.workspaceId,
                selection.projectId,
                actor.userId,
                selection.leadUserId,
                preview.generation,
                JSON.stringify(preview),
                createdAt,
                createdAt + 600_000,
              ],
            );
            const saved = db
              .query<{ id: string }, [string, string, string]>(
                "SELECT id FROM project_approval WHERE workspace_id=? AND actor_id=? AND generation=? AND stopped_at IS NULL",
              )
              .get(actor.workspaceId, actor.userId, preview.generation)!;
            return readProjectApproval(db, saved.id)!;
          })
          .immediate();
      } catch (error) {
        denied(actor, `project.preview:${selection.projectId}`);
        throw error;
      }
    },
    async approve(
      actor: Actor,
      id: string,
      generation: string,
      signal: AbortSignal,
    ): Promise<ProjectApproval> {
      const saved = readProjectApproval(db, id);
      if (
        !saved ||
        saved.workspaceId !== actor.workspaceId ||
        saved.actorId !== actor.userId ||
        saved.generation !== generation ||
        saved.stoppedAt !== null
      ) {
        denied(actor, `project.approve:${id}`);
        throw new Error("This approval does not belong to your current scope.");
      }
      try {
        const workspace = await refresh(actor, [saved.leadUserId], signal);
        const preview = await previewProject(input.tracker, saved.preview.selection, {
          organizationId: workspace.organizationId,
          signal,
        });
        signal.throwIfAborted();
        return db
          .transaction(() => {
            const current = readProjectApproval(db, id)!;
            assertProjectAuthority(db, actor, preview);
            if (input.repository && !input.repository(preview.selection.repository))
              throw new Error("The approved repository is no longer configured.");
            if (
              current.stoppedAt !== null ||
              current.generation !== generation ||
              preview.generation !== generation ||
              (current.approvedAt === null && current.expiresAt <= now())
            )
              throw new Error("The project scope changed or expired. Preview it again.");
            if (preview.problems.length) throw new Error(preview.problems.join(" "));
            const policies = preview.selection.blockers ?? [];
            if (
              policies.length !== preview.externalBlockerIds.length ||
              new Set(policies.map((policy) => policy.blockerLinearIssueId)).size !==
                policies.length ||
              policies.some(
                (policy) => !preview.externalBlockerIds.includes(policy.blockerLinearIssueId),
              )
            )
              throw new Error("Choose a completion policy for every external blocker.");
            if (current.approvedAt !== null) return current;
            for (const issueId of preview.includedIssueIds) {
              const reserved = db
                .query(
                  "SELECT 1 FROM project_approval_issue WHERE workspace_id=? AND issue_id=? AND released_at IS NULL",
                )
                .get(actor.workspaceId, issueId);
              const managed = db
                .query(`SELECT 1 FROM work_item i JOIN linear_session s ON s.session_id=i.session_key
              JOIN workspace w ON w.linear_organization_id=s.organization_id
              WHERE w.id=? AND i.linear_issue_id=? AND i.state NOT IN ('completed','merged','cancelled') LIMIT 1`)
                .get(actor.workspaceId, issueId);
              if (reserved || managed)
                throw new Error("A selected issue is already managed. Remove it from this scope.");
              db.run(
                "INSERT INTO project_approval_issue(workspace_id,issue_id,approval_id) VALUES(?,?,?)",
                [actor.workspaceId, issueId, id],
              );
            }
            db.run("UPDATE project_approval SET approved_at=? WHERE id=? AND approved_at IS NULL", [
              now(),
              id,
            ]);
            auditWorkspaceAccess(db, {
              ...actor,
              action: "project.approved",
              subject: `${id}:${generation}`,
              now: now(),
            });
            return readProjectApproval(db, id)!;
          })
          .immediate();
      } catch (error) {
        denied(actor, `project.approve:${id}`);
        throw error;
      }
    },
  };
}
