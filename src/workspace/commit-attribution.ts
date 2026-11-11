import {
  attributionItemScope,
  delegatedLinearUserIdSteps,
  githubAttribution,
  workspaceLinearMemberSteps,
  type VerifiedGitHubAttribution,
  type Db,
} from "../db";

/**
 * The delegating member's linked GitHub identity, or null when they have not linked one.
 * A local lookup: Paws reads nothing from Linear or GitHub to credit the run.
 */
export async function delegatorCommitCredit(
  store: Db,
  itemId: string,
): Promise<VerifiedGitHubAttribution | null> {
  const scope = await attributionItemScope(store, itemId);
  const actorId = await store.run((q) => delegatedLinearUserIdSteps(q, itemId));
  if (!scope || !actorId) return null;
  const member = await store.run((q) => workspaceLinearMemberSteps(q, scope.workspaceId, actorId));
  return member ? await githubAttribution(store, scope.workspaceId, member.userId) : null;
}
