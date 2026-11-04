import {
  workspaceMemberUsable,
  WORKSPACE_REVOKED_RESPONSE,
  WORKSPACE_REVOKED_SIGN_IN,
} from "../db";
import type { WorkspaceMember } from "../db";
import type { LinearMemberIdentity } from "../linear";

export const isWorkspaceAdmin = (role: string): boolean => role === "admin";

/** The whole answer to a Linear guest, at sign-in and on a delegation. */
export const LINEAR_GUEST_REFUSAL = "Linear guests can't use Paws.";

export type ActionActor = {
  id: string;
  /** Omitted for callers that already verified the Linear event at the boundary. */
  identity?: LinearMemberIdentity;
  /** null means a verified Linear member has never signed in to Paws. */
  member?: Pick<WorkspaceMember, "active" | "role" | "teamIds" | "revokedAt"> | null;
  teamId?: string;
};
export type ActorAction =
  | "prompt"
  | "delegate"
  | "github"
  | { kind: "answer"; allowedIds?: readonly (string | null)[] };
export type ActorEligibility =
  | { allowed: true }
  | { allowed: false; reason: string; signIn?: true; response?: true };

/** Authorization policy only. Callers retain installation checks and race rechecks. */
export function canAct(actor: ActionActor, action: ActorAction): ActorEligibility {
  if (!actor.id.trim() || actor.id === "unknown" || actor.id === "linear")
    return { allowed: false, reason: "Paws could not tell who is acting in this session." };
  const deny = (reason: string): ActorEligibility => ({ allowed: false, reason });
  const identity = actor.identity;
  if (identity) {
    if (identity.userId !== actor.id)
      return deny("Linear returned a different person for this session.");
    if (!identity.active) return deny("Your Linear account is not active.");
    if (identity.guest) return deny(LINEAR_GUEST_REFUSAL);
    if (actor.teamId && !identity.teamIds.includes(actor.teamId))
      return deny("You are not a member of this issue's Linear team.");
  }
  const member = actor.member;
  if (member) {
    if (member.revokedAt !== null)
      return action === "delegate"
        ? { allowed: false, reason: WORKSPACE_REVOKED_RESPONSE, response: true }
        : deny(WORKSPACE_REVOKED_SIGN_IN);
    if (!workspaceMemberUsable(member))
      return deny("Your Paws workspace membership is not active.");
    if (actor.teamId && !member.teamIds.includes(actor.teamId))
      return deny("You are not a member of this issue's Linear team.");
  }
  if ((action === "delegate" || action === "github") && !member)
    return {
      allowed: false,
      signIn: true,
      reason: "It waits until you sign in to Paws with your Linear account.",
    };
  if (typeof action === "object" && action.allowedIds && !action.allowedIds.includes(actor.id))
    return deny("Only the people named in this question may answer it.");
  return { allowed: true };
}
