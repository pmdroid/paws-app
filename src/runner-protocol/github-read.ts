/**
 * Why a turn's read-only GitHub token did not reach the agent: the token Paws sent failed the
 * runner's check (`format`), fetching it failed (`fetch`), its expiry was out of range (`expiry`),
 * or the worker could not write it to gh's config (`write`). Fixed text, never the error message.
 */
export const GITHUB_READ_FAILURES = ["format", "fetch", "expiry", "write"] as const;
export type GitHubReadFailure = (typeof GITHUB_READ_FAILURES)[number];

/** How long a turn waits for its read token before its prompt drops the `gh` line. */
export const GITHUB_READ_CONFIRM_MS = 30_000;
