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
export { eligibleRunners, RUNNER_ONLINE_MS } from "./eligible";
export type PlacementProfile = Pick<RunnerProfile, "agent"> & { model?: string | null };
export type PlacementRequest = {
  itemId?: string;
  sessionId?: string;
  profile?: PlacementProfile;
  role: "implementer" | "reviewer";
  purpose: PlacementPurpose;
  excludeRunnerIds?: readonly string[];
  /** The runner holding the item's last agent session, for implementer work. */
  session?: { runnerId: string };
  /** Slots the caller holds per runner for runs it placed but has not assigned yet. */
  reserved?: ReadonlyMap<string, number>;
  signal?: AbortSignal;
};
export type RunnerPlacement = {
  candidates(input: PlacementRequest): Promise<readonly { id: string; workspaceId: string }[]>;
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
