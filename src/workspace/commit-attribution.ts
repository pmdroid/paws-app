import type { Database } from "bun:sqlite";
import {
  attributionItemScope,
  delegatedLinearUserId,
  githubAttribution,
  workspaceLinearMember,
  type VerifiedGitHubAttribution,
} from "../db";

/**
 * The delegating member's linked GitHub identity, or null when they have not linked one.
 * A local lookup: Paws reads nothing from Linear or GitHub to credit the run.
 */
export function delegatorCommitCredit(
  db: Database,
  itemId: string,
): VerifiedGitHubAttribution | null {
  const scope = attributionItemScope(db, itemId);
  const actorId = delegatedLinearUserId(db, itemId);
  if (!scope || !actorId) return null;
  const member = workspaceLinearMember(db, scope.workspaceId, actorId);
  return member ? githubAttribution(db, scope.workspaceId, member.userId) : null;
}
