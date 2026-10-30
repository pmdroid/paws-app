/**
 * Closeout draft 0.1 policy loader.
 *
 * QM-35 wires this module into the closeout-spec facade. Callers import this
 * index. The loader reads policy bytes through {@link GitReader} and, when the
 * remote entry is absent, from the home directory.
 */

export { canonicalJson, policyCanonicalJson, recheckDigest } from "./canonical";
export {
  createFakeGitReader,
  type FakeGitReader,
  type GitBlob,
  type GitFailure,
  type GitReader,
} from "./git";
export {
  GLOBAL_POLICY_CODE,
  loadCommitPolicy,
  loadOriginMainRootFiles,
  loadPolicy,
  NO_CLOSEOUT_POLICY,
  ROOT_FILE_MAX_BYTES,
  type LoadPolicyInput,
  type PolicyLoadOutcome,
  type RootFilesLoad,
} from "./load";
export { anyPathMatches, pathsMatch } from "./paths";
export { POLICY_MAX_BYTES, PUBLIC_POLICY_PATH, UNKNOWN_POLICY_KEYS_CODE } from "./resolve";
export { createPolicyParser, parsePolicy, type ParsedPolicy, type PolicyParser } from "./document";
export { policyKeys } from "./keys";
