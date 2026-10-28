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
  | "revoked"
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
  /** Include revoked runners in rejection diagnostics. They remain ineligible. */
  includeRevoked?: boolean;
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
  /** Runner assigned to this run. Work moves only when unavailable; preparation is unpinned. */
  pinnedRunnerId?: string;
  /** For unpinned work: the runner tried first when it has a free slot, the run's own. */
  preferRunnerId?: string;
  /** The runner a handed-over run left: the pin no longer holds there, and the run avoids it. */
  handedOverFrom?: string;
  /** The runner holding the item's last agent session, for implementer work. */
  session?: { runnerId: string };
  /**
   * For implementer work leaving its pinned runner: whether `runnerId` may restore the run's
   * sealed session snapshot, and whether it runs the agent version that wrote it. Null when it
   * may not, or there is no snapshot.
   */
  restore?: (runnerId: string) => { sameVersion: boolean } | null;
  /** Slots the caller holds per runner for runs it placed but has not assigned yet. */
  reserved?: ReadonlyMap<string, number>;
  /** Reports policy and ranking rejections for this selection, without credentials. */
  onRejected?: (runnerId: string, reason: string) => void;
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

/** Why placement ranked a runner ahead of the others, recorded with its usage. */
export type PlacementReason = "session_restore";

export {
  createRunnerPlacement,
  LOAD_HALF_LIFE_MS,
  LOAD_HISTORY_MS,
  SESSION_GRACE_MS,
} from "./placement";

export { createRunnerPlacementBrowser } from "./browser";
