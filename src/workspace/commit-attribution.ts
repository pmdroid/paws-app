import type { Database } from "bun:sqlite";
import {
  attributionItemScope,
  delegatedLinearUserIdSteps,
  githubAttribution,
  sqliteDb,
  workspaceLinearMemberSteps,
  type VerifiedGitHubAttribution,
} from "../db";

/**
 * The delegating member's linked GitHub identity, or null when they have not linked one.
 * A local lookup: Paws reads nothing from Linear or GitHub to credit the run.
 */
export async function delegatorCommitCredit(
  db: Database,
  itemId: string,
): Promise<VerifiedGitHubAttribution | null> {
  const store = sqliteDb(db);
  const scope = attributionItemScope(db, itemId);
  const actorId = await store.run((q) => delegatedLinearUserIdSteps(q, itemId));
  if (!scope || !actorId) return null;
  const member = await store.run((q) => workspaceLinearMemberSteps(q, scope.workspaceId, actorId));
  return member ? githubAttribution(db, scope.workspaceId, member.userId) : null;
}
