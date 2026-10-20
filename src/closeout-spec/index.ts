/**
 * Closeout draft 0.1 seam.
 *
 * Public surface is the frozen types, the spec pin (`SPEC_VERSION`,
 * `SPEC_COMMIT`), and the operations the gate calls: `validate`, `run`,
 * `addReview`, `decision`, and `digest`.
 */

export { SPEC_COMMIT, SPEC_VERSION } from "./types";

export type {
  Artifact,
  CandidateIdentity,
  CommandExec,
  CommandRecord,
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  DecisionDocument,
  DecisionItem,
  DecisionName,
  DecisionPolicy,
  DecisionWarning,
  EvidenceInvalid,
  EvidenceRecord,
  EvidenceSnapshot,
  EvidenceStore,
  Finding,
  Gate,
  Independence,
  ItemState,
  PolicyCommand,
  PolicyDocument,
  PolicyFile,
  PolicyIdentity,
  PolicyImport,
  PolicyItem,
  PolicyLoadResult,
  PolicyPaths,
  PolicyReview,
  PolicySetupStep,
  PolicySource,
  ProducerIdentity,
  ResolvedCommand,
  ResolvedItem,
  ResolvedPolicy,
  ResolvedPolicyAbsent,
  ResolvedPolicyPresent,
  ResolvedRequirement,
  ResolvedReview,
  ResolvedSetup,
  ResolvedUnsupported,
  RetryPolicy,
  RetryScope,
  Reviewer,
  ReviewProducer,
  ReviewRecord,
  ReviewRequest,
  ReviewResult,
  Severity,
  SpecVersion,
} from "./types";

export { credentialSecrets } from "./run/env";
export type {
  CloseoutOutputStream,
  CloseoutProgress,
  CloseoutProgressIdentity,
  CloseoutProgressStep,
  CloseoutStepKind,
  CloseoutStepState,
} from "./run/progress";
export { scrubText } from "./run/scrub";
export {
  addReview,
  decision,
  digest,
  policyFixBudget,
  retryBaseline,
  reviewRequirements,
  run,
  trustedPolicyFiles,
  validate,
  workspacePolicyFiles,
} from "./facade";
export { decodePolicyFiles, encodePolicyFiles } from "./policy/transfer";
export type { PolicyFilesLoad } from "./policy/load";
export type {
  AddReviewInput,
  AddReviewResult,
  DecisionInput,
  DigestResult,
  ReviewIntake,
  RunRequest,
  ValidateResult,
  PolicyGit,
} from "./facade";

export { loadReviewMaterial, renderReviewPrompt } from "./review/index";
export { createReviewer, FINDING_FORMAT, formatFixFeedback, parseFindings } from "./review/index";
export type {
  FeedbackRecord,
  InvalidReview,
  RecordedReview,
  ReviewAgent,
  ReviewAgentReply,
  ReviewAgentRequest,
  ReviewerOptions,
  ReviewRunResult,
} from "./review/index";

export type { PawsCommandRunner, LoggedCommandRequest } from "./run/exec";
export {
  createCloseoutSession,
  type SessionCommandResult,
  type CloseoutSession,
  type CloseoutSessionOptions,
} from "./session";
