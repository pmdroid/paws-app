/**
 * Closeout command runner.
 *
 * Checks out the candidate in a detached worktree, runs in-scope setup steps
 * and commands, and stores command records. Policy loading and the acceptance
 * decision stay in their own modules.
 */

export { credentialSecrets, scrubCommandEnv } from "./env";
export { createCommandRunner } from "./exec";
export type { CommandRunnerOptions, LoggedCommandRequest, PawsCommandRunner } from "./exec";
export { matchPaths } from "./paths";
export type {
  CloseoutOutputStream,
  CloseoutProgress,
  CloseoutProgressIdentity,
  CloseoutProgressStep,
  CloseoutStepKind,
  CloseoutStepState,
} from "./progress";
export { PAWS_CLOSEOUT_PRODUCER, runCloseoutCommands } from "./run";
export type { CloseoutRunInput, CloseoutRunResult, CommandDisposition } from "./run";
export { createStreamScrubber, scrubText } from "./scrub";
