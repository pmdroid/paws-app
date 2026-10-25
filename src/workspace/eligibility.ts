import type { WorkspaceMember } from "../db";
import type { LinearMemberIdentity } from "../linear";

export const isWorkspaceAdmin = (role: string): boolean => role === "owner" || role === "admin";

export type ActionActor = {
  id: string;
  /** Omitted for callers that already verified the Linear event at the boundary. */
  identity?: LinearMemberIdentity;
  /** null means a verified Linear member has never signed in to Paws. */
  member?: Pick<WorkspaceMember, "active" | "role" | "teamIds"> | null;
  teamId?: string;
  teamName?: string | null;
};
export type ActorAction =
  | "prompt"
  | "delegate"
  | "github"
  | { kind: "answer"; allowedIds?: readonly (string | null)[] };
export type ActorEligibility =
  | { allowed: true }
  | { allowed: false; reason: string; signIn?: true };

/** Authorization policy only. Callers retain installation checks and race rechecks. */
export function canAct(actor: ActionActor, action: ActorAction): ActorEligibility {
  if (!actor.id.trim() || actor.id === "unknown" || actor.id === "linear")
    return { allowed: false, reason: "Paws could not tell who is acting in this session." };
  const deny = (reason: string): ActorEligibility => ({ allowed: false, reason });
  const ask = `Ask a member of ${actor.teamName ?? "this issue's team"} to delegate this issue.`;
  const identity = actor.identity;
  if (identity) {
    if (identity.userId !== actor.id)
      return deny("Linear returned a different person for this session.");
    if (!identity.active) return deny("Your Linear account is not active.");
    if (identity.guest) return deny(`Linear guests cannot delegate issues to Paws. ${ask}`);
    if (actor.teamId && !identity.teamIds.includes(actor.teamId))
      return deny("You are not a member of this issue's Linear team.");
  }
  const member = actor.member;
  if (member) {
    if (!member.active) return deny("Your Paws workspace membership is not active.");
    if (member.role === "observer")
      return deny(`Observers in the Paws workspace cannot delegate issues to Paws. ${ask}`);
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
