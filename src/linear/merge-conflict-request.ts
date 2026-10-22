/**
 * Linear's pull request review page offers "Fix merge conflicts" on a
 * conflicting pull request. It reaches the agent session as a plain prompt,
 * so it is recognized by its text: a request to fix or resolve merge conflicts.
 */
const MERGE_CONFLICT_REQUEST = /\b(?:fix|resolve)\w*\b[^.\n]{0,40}?\bmerge[ -]conflicts?\b/i;

export function isMergeConflictRequest(body: string): boolean {
  return MERGE_CONFLICT_REQUEST.test(body);
}
