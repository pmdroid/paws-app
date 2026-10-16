import { teamRepositoryAllowedSql } from "../db";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { TrackerAdapter } from "../linear";

const issueId = z.string().min(1).max(256);
export const ExternalBlockerPolicySchema = z.discriminatedUnion("outcome", [
  z.strictObject({ blockerLinearIssueId: issueId, outcome: z.literal("completion") }),
  z.strictObject({
    blockerLinearIssueId: issueId,
    outcome: z.literal("merge"),
    repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/),
    targetBranch: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s~^:?*[\\]+$/),
    pullRequestNumber: z.number().int().positive().safe(),
  }),
]);
export type ExternalBlockerPolicy = z.infer<typeof ExternalBlockerPolicySchema>;
type Target = { workspaceId: string; itemId: string };
type SavedPolicy = { policy: string; userId: string; revision: number };
export type MergeEvidence = {
  merged: boolean;
  repository: string;
  targetBranch: string;
  pullRequestNumber: number;
  headSha: string;
  mergeSha: string | null;
};
export type InspectBlockerMerge = (
  input: Extract<ExternalBlockerPolicy, { outcome: "merge" }> & { signal?: AbortSignal },
) => Promise<MergeEvidence>;

function savedPolicies(db: Database, target: Target): SavedPolicy[] {
  return db
    .query<SavedPolicy, [string, string]>(
      `SELECT policy,user_id AS userId,revision FROM item_blocker_policy
     WHERE workspace_id=? AND item_id=? ORDER BY blocker_issue_id`,
    )
    .all(target.workspaceId, target.itemId);
}

export function readExternalBlockerPolicies(db: Database, target: Target): ExternalBlockerPolicy[] {
  return savedPolicies(db, target).map((row) =>
    ExternalBlockerPolicySchema.parse(JSON.parse(row.policy)),
  );
}

function permitted(
  db: Database,
  target: Target,
  userId: string,
  policy: ExternalBlockerPolicy,
): boolean {
  return (
    db
      .query(`SELECT 1 FROM linear_session s
    JOIN workspace w ON w.linear_organization_id=s.organization_id
    JOIN workspace_member m ON m.workspace_id=w.id AND m.user_id=?
    JOIN workspace_user_team t ON t.workspace_id=w.id AND t.user_id=m.user_id AND t.team_id=s.team_id
    WHERE w.id=? AND EXISTS(SELECT 1 FROM work_item i WHERE i.id=? AND i.session_key=s.session_id) AND s.stopped_at IS NULL
    AND m.active=1 AND m.role IN ('owner','admin','member')
    AND (?5 IS NULL OR ${teamRepositoryAllowedSql("w.id", "s.team_id", "lower(?5)")})`)
      .get(
        userId,
        target.workspaceId,
        target.itemId,
        policy.outcome === "merge" ? policy.repository : null,
        policy.outcome === "merge" ? policy.repository : null,
      ) !== null
  );
}

export function externalPolicyBinding(db: Database, target: Target): string {
  return JSON.stringify(
    savedPolicies(db, target).map((row) => [
      row,
      permitted(db, target, row.userId, ExternalBlockerPolicySchema.parse(JSON.parse(row.policy))),
    ]),
  );
}

export function saveExternalBlockerPolicies(
  db: Database,
  input: Target & { userId: string; policies: readonly ExternalBlockerPolicy[]; now?: number },
): void {
  const policies = z.array(ExternalBlockerPolicySchema).max(500).parse(input.policies);
  if (new Set(policies.map((policy) => policy.blockerLinearIssueId)).size !== policies.length)
    throw new Error("A blocker must have exactly one completion policy.");
  db.transaction(() => {
    if (
      !permitted(db, input, input.userId, { blockerLinearIssueId: "access", outcome: "completion" })
    )
      throw new Error("An authorized project member must approve blocker outcomes.");
    for (const policy of policies) {
      if (!permitted(db, input, input.userId, policy))
        throw new Error("The blocker repository is not authorized for this project.");
      db.run(
        `INSERT INTO item_blocker_policy(workspace_id,item_id,blocker_issue_id,policy,user_id,revision)
        VALUES(?,?,?,?,?,1) ON CONFLICT(item_id,blocker_issue_id) DO UPDATE SET
        policy=excluded.policy,user_id=excluded.user_id,revision=item_blocker_policy.revision+1
        WHERE item_blocker_policy.workspace_id=excluded.workspace_id`,
        [
          input.workspaceId,
          input.itemId,
          policy.blockerLinearIssueId,
          JSON.stringify(policy),
          input.userId,
        ],
      );
    }
    for (const row of readExternalBlockerPolicies(db, input)) {
      if (!policies.some((policy) => policy.blockerLinearIssueId === row.blockerLinearIssueId))
        throw new Error("An approved blocker policy must be replaced explicitly.");
    }
    db.run("DELETE FROM item_dependency_snapshot WHERE item_id=?", [input.itemId]);
    db.run(
      `INSERT INTO workspace_access_audit(workspace_id,user_id,action,subject,created_at)
      VALUES(?,?,'dependency.policy.approved',?,?)`,
      [
        input.workspaceId,
        input.userId,
        JSON.stringify({ itemId: input.itemId, policies }),
        input.now ?? Date.now(),
      ],
    );
  }).immediate();
}

export function managedBlockerSatisfied(
  db: Database,
  target: Target,
  issue: string,
): boolean | null {
  const items = db
    .query<
      { state: string; mode: string | null; cancelRequested: number; mergeSha: string | null },
      [string, string, string]
    >(
      `SELECT i.state,t.mode,i.cancel_requested AS cancelRequested,f.merge_sha AS mergeSha
     FROM work_item i
     JOIN linear_session s ON s.session_id=i.session_key
     JOIN workspace w ON w.linear_organization_id=s.organization_id
     LEFT JOIN work_item_task t ON t.item_id=i.id LEFT JOIN remote_merge_fact f ON f.item_id=i.id
     WHERE w.id=? AND i.linear_issue_id=? AND i.delegation_id<>(SELECT delegation_id FROM work_item WHERE id=?)
     AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
     ORDER BY i.created_at, i.id`,
    )
    .all(target.workspaceId, issue, target.itemId);
  if (!items.length) return null;
  const active = items.filter((item) => item.state !== "cancelled" && !item.cancelRequested);
  const item = (active.length > 0 ? active : items).at(-1)!;
  return (
    !item.cancelRequested &&
    ((item.state === "merged" && !!item.mergeSha) ||
      (item.state === "completed" && (item.mode === "answer" || item.mode === "artifact")))
  );
}

export type BlockerEvidence = {
  satisfied: boolean;
  reason: string;
  checkedAt: number;
  merge?: MergeEvidence;
};

export function readExternalBlockerEvidence(
  db: Database,
  target: { workspaceId: string; epicId: string },
): Record<string, BlockerEvidence> {
  const rows = db
    .query<{ evidence: string }, [string, string]>(
      `SELECT s.external_evidence AS evidence FROM item_dependency_snapshot s
       JOIN work_item i ON i.id=s.item_id
       WHERE s.workspace_id=? AND i.delegation_id=? ORDER BY s.generation,i.position,i.id`,
    )
    .all(target.workspaceId, target.epicId);
  const evidence: Record<string, BlockerEvidence> = {};
  for (const row of rows)
    for (const [id, entry] of Object.entries(
      JSON.parse(row.evidence) as Record<string, BlockerEvidence>,
    ))
      if (!evidence[id] || entry.checkedAt >= evidence[id].checkedAt) evidence[id] = entry;
  return evidence;
}

export async function inspectExternalBlockers(
  db: Database,
  input: Target & {
    issues: string[];
    inspectMerge?: InspectBlockerMerge;
    tracker: Pick<TrackerAdapter, "listIssuePullRequests">;
    signal?: AbortSignal;
  },
): Promise<Record<string, BlockerEvidence>> {
  const result: Record<string, BlockerEvidence> = {};
  for (const row of savedPolicies(db, input)) {
    const policy = ExternalBlockerPolicySchema.parse(JSON.parse(row.policy));
    if (!input.issues.includes(policy.blockerLinearIssueId)) continue;
    input.signal?.throwIfAborted();
    let satisfied = false;
    let reason = "Review blocker permissions and approve its outcome again.";
    let merge: MergeEvidence | undefined;
    if (permitted(db, input, row.userId, policy)) {
      if (policy.outcome === "completion") {
        satisfied = true;
        reason = "Awaiting Linear completion.";
      } else {
        reason = "Merge the approved pull request into the selected target branch.";
        try {
          const links = await input.tracker.listIssuePullRequests?.(policy.blockerLinearIssueId, {
            signal: input.signal,
          });
          const linked = links?.some(
            (link) =>
              link.repository.toLowerCase() === policy.repository.toLowerCase() &&
              link.pullRequestNumber === policy.pullRequestNumber,
          );
          if (linked) merge = await input.inspectMerge?.({ ...policy, signal: input.signal });
          satisfied =
            !!merge &&
            merge.merged &&
            merge.repository.toLowerCase() === policy.repository.toLowerCase() &&
            merge.targetBranch === policy.targetBranch &&
            merge.pullRequestNumber === policy.pullRequestNumber &&
            /^[a-f0-9]{40}$/.test(merge.headSha) &&
            /^[a-f0-9]{40}$/.test(merge.mergeSha ?? "");
          if (satisfied) reason = "The approved pull request is merged.";
          else if (!linked)
            reason =
              "Link the approved pull request to its Linear blocker and refresh the dependency.";
          else if (!merge) reason = "Restore GitHub access and refresh the dependency.";
        } catch {
          input.signal?.throwIfAborted();
          reason = "Restore GitHub access and refresh the dependency.";
        }
      }
    }
    result[policy.blockerLinearIssueId] = {
      satisfied,
      reason,
      checkedAt: Date.now(),
      ...(merge ? { merge } : {}),
    };
  }
  return result;
}
