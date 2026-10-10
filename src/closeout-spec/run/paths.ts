/**
 * Changed-path filter for setup steps and commands.
 *
 * Closeout draft 0.1 §5.3 lives in the policy module. This keeps the runner's
 * `matchPaths(patterns, paths)` name and calls `anyPathMatches`, which uses
 * `pathsMatch` for each pattern and path.
 */

import { anyPathMatches } from "../policy/paths";

/** True when any pattern matches any changed path. */
export function matchPaths(patterns: readonly string[], paths: readonly string[]): boolean {
  return anyPathMatches(patterns, paths);
}
