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
/** First runner release whose Closeout policy parser knows a check's `ci` key. 0.1.48 rejects it. */
export const CLOSEOUT_CI_KEY_RUNNER_VERSION: RunnerVersion = [0, 1, 49];
/**
 * First runner release whose Closeout policy parser leaves out a key it does not know, with a
 * warning, instead of blocking the run, and knows a check's `recheck` key.
 */
export const CLOSEOUT_POLICY_KEYS_RUNNER_VERSION: RunnerVersion = [0, 1, 49];
