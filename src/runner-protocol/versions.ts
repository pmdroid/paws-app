/**
 * The oldest runner release Paws places work on. Raise it to a released version when Paws starts
 * relying on a runner feature; the runner release workflow fails when a tag is below it
 * (`scripts/check-runner-versions.ts`).
 */
export type RunnerVersion = readonly [major: number, minor: number, patch: number];

export const MINIMUM_RUNNER_VERSION: RunnerVersion = [0, 1, 93];
export const REVIEW_COMMAND_OAUTH_RUNNER_VERSION: RunnerVersion = [0, 1, 88];
export const SLACK_REPLY_RUNNER_VERSION: RunnerVersion = [0, 1, 94];
