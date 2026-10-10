/**
 * Closeout draft 0.1 policy loader.
 *
 * QM-35 wires this module into the closeout-spec facade. Callers import this
 * index. The loader reads policy bytes through {@link GitReader} and, when the
 * remote entry is absent, from the home directory.
 */

export { canonicalJson, policyCanonicalJson } from "./canonical";
export {
  createFakeGitReader,
  type FakeGitReader,
  type GitBlob,
  type GitFailure,
  type GitReader,
} from "./git";
export {
  GLOBAL_POLICY_CODE,
  loadPolicy,
  NO_CLOSEOUT_POLICY,
  type LoadPolicyInput,
  type PolicyLoadOutcome,
} from "./load";
export { anyPathMatches, pathsMatch } from "./paths";
export { PUBLIC_POLICY_PATH } from "./resolve";
