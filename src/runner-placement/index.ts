import type { RunnerProfile, RunnerResult, RunnerHelperResult } from "../runner-protocol";

export { quotaSignal, type QuotaSignal } from "./quota";

export type PlacementPurpose = "prepare" | "work" | "helper";

/** Why a runner may or may not run a person's work. `own` and `lead-shared` are eligible. */
export type EligibleRunnerReason =
  | "own"
  | "lead-shared"
  | "not-yours"
  | "not-shared"
  | "no-project-lead"
  | "offline"
  | "paused"
  | "agent-not-signed-in"
  | "auth-expired"
  | "owner-not-in-team"
  | "owner-inactive";
export type EligibleRunnersInput = {
  workspaceId: string;
  /** The Linear team of the issue. */
  teamId: string;
  /** The `workspace_user` who owns the work. */
  ownerUserId: string | null;
  /** The `workspace_user` ids of the Linear project leads across the delegation. */
  leadUserIds: readonly string[];
  agent: string;
  purpose: PlacementPurpose;
  now?: number;
};
export type EligibleRunner = {
  id: string;
  workspaceId: string;
  ownerId: string;
  sharing: number;
  ready: number;
  authExpired: number;
  quotaState: string;
  cooldownUntil: number;
  virtualFinish: number;
  lastUsedAt: number;
  resolvedModel: string | null;
  eligible: boolean;
  reason: EligibleRunnerReason;
};
export {
  eligibleRunners,
  itemOwnerEligibleRunner,
  itemOwnerHasEligibleRunner,
  itemOwnerRunnerSetupNeed,
  RUNNER_ONLINE_MS,
} from "./eligible";
/**
 * Why the owner of the work has no runner Paws may use: no runner of theirs or shared with them,
 * or their own runner whose agent is not signed in. Same shape as `RunnerSetupNeed` in core.
 */
export type RunnerSetupNeed =
  | { reason: "no-runner" }
  | { reason: "agent-not-signed-in"; runnerId: string; runnerName: string; agent: string };
export type PlacementProfile = Pick<RunnerProfile, "agent"> & { model?: string | null };
export type PlacementRequest = {
  itemId?: string;
  sessionId?: string;
  profile?: PlacementProfile;
  role: "implementer" | "reviewer";
  purpose: PlacementPurpose;
  /** Failed hosts to avoid for new placement; an online pin retries a fresh session there. */
  excludeRunnerIds?: readonly string[];
  /** Runner assigned to this run. Only an unavailable host permits moving the run. */
  pinnedRunnerId?: string;
  /** The runner holding the item's last agent session, for implementer work. */
  session?: { runnerId: string };
  /** Slots the caller holds per runner for runs it placed but has not assigned yet. */
  reserved?: ReadonlyMap<string, number>;
  signal?: AbortSignal;
};
export type RunnerPlacement = {
  candidates(input: PlacementRequest): Promise<readonly { id: string; workspaceId: string }[]>;
  /**
   * Why the person who owns the work has no runner Paws may use, or null when one is eligible
   * (busy or not) or one of theirs is only offline or paused. Reads SQLite only.
   */
  setupNeed?(input: PlacementRequest): RunnerSetupNeed | null;
  started(input: {
    commandId: string;
    runnerId: string;
    itemId?: string;
    sessionId?: string;
    runId?: string;
    profile?: PlacementProfile;
    role: "implementer" | "reviewer";
    purpose: PlacementPurpose;
    startedAt: number;
  }): void;
  finished(input: {
    commandId: string;
    runnerId: string;
    profile?: PlacementProfile;
    result?: RunnerResult | RunnerHelperResult;
    failure?: "heartbeat_lost";
    finishedAt: number;
  }): { retryable: boolean; usageLimit?: { resetsAt: number | null } };
};

export {
  createRunnerPlacement,
  LOAD_HALF_LIFE_MS,
  LOAD_HISTORY_MS,
  SESSION_GRACE_MS,
} from "./placement";

export { createRunnerPlacementBrowser } from "./browser";
