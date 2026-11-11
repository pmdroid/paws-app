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
  const member = await delegatingMember(store, itemId);
  return member ? await githubAttribution(store, member.workspaceId, member.userId) : null;
}

export async function delegatorPullRequestToken(
  store: Db,
  itemId: string,
  userToken: (workspaceId: string, userId: string) => Promise<string | null>,
): Promise<{ login: string; token: string } | null> {
  const member = await delegatingMember(store, itemId);
  if (!member) return null;
  const identity = await githubAttribution(store, member.workspaceId, member.userId);
  const token = identity && (await userToken(member.workspaceId, member.userId));
  return identity && token ? { login: identity.login, token } : null;
}

async function delegatingMember(store: Db, itemId: string) {
  const scope = await attributionItemScope(store, itemId);
  const actorId = await store.run((q) => delegatedLinearUserIdSteps(q, itemId));
  if (!scope || !actorId) return null;
  const member = await store.run((q) => workspaceLinearMemberSteps(q, scope.workspaceId, actorId));
  return member ? { workspaceId: scope.workspaceId, userId: member.userId } : null;
}
