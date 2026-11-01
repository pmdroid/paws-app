/**
 * The first runner release each runner feature needs. This is the only place a minimum runner
 * version is declared: a new feature sets its minimum to the next release, and the runner release
 * workflow fails when a tag is below any of them (`scripts/check-runner-versions.ts`).
 */
export type RunnerVersion = readonly [major: number, minor: number, patch: number];

/** First runner release that rebases a checkpoint onto a main that is not its ancestor. */
export const REBASE_RUNNER_VERSION: RunnerVersion = [0, 1, 23];
/** First runner release that resumes the item's earlier agent session on the same runner. */
export const SESSION_RESUME_RUNNER_VERSION: RunnerVersion = [0, 1, 24];
/** First runner release whose command schema accepts `runtimes`. Older runners reject the field. */
export const RUNTIMES_RUNNER_VERSION: RunnerVersion = [0, 1, 26];
/** First runner release whose command schema accepts any mise backend, not only core and `aqua:`. */
export const ANY_MISE_BACKEND_RUNNER_VERSION: RunnerVersion = [0, 1, 52];
/** First runner release that snapshots a run's Claude session when a turn ends. */
export const CLAUDE_SESSION_SNAPSHOT_RUNNER_VERSION: RunnerVersion = [0, 1, 42];
/** First runner release that restores a Claude session snapshot before the agent starts. */
export const CLAUDE_SESSION_RESTORE_RUNNER_VERSION: RunnerVersion = [0, 1, 43];
/** First runner release that hands a running session over. */
export const HANDOVER_RUNNER_VERSION: RunnerVersion = [0, 1, 44];
/** First runner release that snapshots a Codex rollout at turn end and restores it. */
export const CODEX_SESSION_RUNNER_VERSION: RunnerVersion = [0, 1, 45];
/** First runner release that snapshots a Grok session folder at turn end and restores it. */
export const GROK_SESSION_RUNNER_VERSION: RunnerVersion = [0, 1, 46];
/** First runner release that checkpoints a running turn on its interval and before a stop. */
export const CHECKPOINT_RUNNER_VERSION: RunnerVersion = [0, 1, 46];
/** First runner release that runs the agent's own review command for a `review` command. */
export const REVIEW_COMMAND_RUNNER_VERSION: RunnerVersion = [0, 1, 47];
/** First runner release that rebases a candidate onto its moved branch and pushes it again. */
export const CANDIDATE_REBASE_RUNNER_VERSION: RunnerVersion = [0, 1, 48];
/**
 * First runner release whose watchdog uses `creditedLeaseUntil` while Paws is unreachable.
 * Paws moves that runner's lease by the same rule and tells it the budget on heartbeat.
 * Older runners are not told and are not moved; they stop at the lease plus the grace.
 */
export const OFFLINE_LEASE_RUNNER_VERSION: RunnerVersion = [0, 1, 53];
/** First runner release whose policy transfer accepts the whole bundle Closeout sends to it. */
export const POLICY_TRANSFER_RUNNER_VERSION: RunnerVersion = [0, 1, 52];

/** First runner release accepting the read-only daily finding grouping helper purpose. */
export const FINDING_GROUPS_RUNNER_VERSION: RunnerVersion = [0, 1, 53];
export const OPENCODE_RUNNER_VERSION: RunnerVersion = [0, 1, 53];
export const SKILL_HOOK_RUNNER_VERSION: RunnerVersion = [0, 1, 53];
/**
 * First runner release whose Closeout policy parser knows a check's `ci` key. 0.1.48 rejects it,
 * and 0.1.49 through 0.1.52 shipped without it. The next runner is 0.1.53.
 */
export const CLOSEOUT_CI_KEY_RUNNER_VERSION: RunnerVersion = [0, 1, 53];
/**
 * First runner release whose Closeout policy parser leaves out a key it does not know, with a
 * warning, instead of blocking the run, and knows a check's `recheck` key. Same release as `ci`:
 * 0.1.52 is the newest tag, so both land on 0.1.53.
 */
export const CLOSEOUT_POLICY_KEYS_RUNNER_VERSION: RunnerVersion = [0, 1, 53];
/** First runner release that requests Closeout policies in bounded chunks. */
export const CLOSEOUT_POLICY_CHUNKS_RUNNER_VERSION: RunnerVersion = [0, 1, 53];

/** First runner release retaining results across outages and counting only active awake work. */
export const DURABLE_RESULTS_RUNNER_VERSION: RunnerVersion = [0, 1, 55];
export const DURABLE_PUBLICATION_RUNNER_VERSION: RunnerVersion = [0, 1, 55];
export const LIVE_PREVIEW_RUNNER_VERSION: RunnerVersion = [0, 1, 56];
