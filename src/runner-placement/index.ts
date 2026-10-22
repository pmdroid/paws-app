import type { RunnerProfile, RunnerResult, RunnerHelperResult } from "../runner-protocol";

export { quotaSignal, type QuotaSignal } from "./quota";

export type PlacementPurpose = "prepare" | "work" | "helper";
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

export { createRunnerPlacement, SESSION_GRACE_MS } from "./placement";

export { createRunnerPlacementBrowser } from "./browser";
