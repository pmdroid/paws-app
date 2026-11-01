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
  CiCheckConclusion,
  CiProvenance,
  CiResult,
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
  EarlierFinding,
  EvidenceApproval,
  EvidenceApprovalMode,
  EvidenceInvalid,
  EvidenceMedia,
  EvidenceRecord,
  EvidenceSnapshot,
  EvidenceStore,
  Finding,
  Gate,
  Independence,
  ItemState,
  PolicyCommand,
  PolicyDocument,
  PolicyEvidence,
  PolicyFile,
  PolicyIdentity,
  PolicyImport,
  PolicyItem,
  PolicyLoadResult,
  PolicyPaths,
  PolicyReview,
  PolicyRule,
  ReviewScope,
  PolicySetupStep,
  PolicySource,
  ProducerIdentity,
  PublishedEvidence,
  ResolvedCommand,
  ResolvedEvidence,
  ResolvedItem,
  ResolvedPolicy,
  ResolvedPolicyAbsent,
  ResolvedPolicyPresent,
  ResolvedRequirement,
  ResolvedReview,
  ResolvedRule,
  ResolvedSetup,
  ResolvedUnsupported,
  RetryPolicy,
  RetryScope,
  RuleOnFail,
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
  approvalRules,
  ciMappings,
  decision,
  digest,
  candidatePolicyDigest,
  candidatePolicyDigests,
  policyCheckPaths,
  policyFixBudget,
  preExistingFindings,
  fixAttemptLimit,
  fixesLeft,
  retryBaseline,
  reviewRecordsSince,
  reviewRequirements,
  reviewRoundFindings,
  run,
  trustedPolicyFiles,
  trustedRootFiles,
  validate,
  visualReviewRequirements,
  workspacePolicyFiles,
} from "./facade";
export { approvalsAtHead, fixChangedPaths, samePatch } from "./published";
export {
  decodePolicyFiles,
  encodePolicyFiles,
  encodePolicyChunk,
  decodePolicyChunk,
} from "./policy/transfer";
export { policyKeys } from "./policy/keys";
export type { PolicyFilesLoad, RootFilesLoad } from "./policy/load";
export type {
  AddReviewInput,
  AddReviewResult,
  DecisionInput,
  DigestResult,
  PolicyDigests,
  ReviewIntake,
  RunRequest,
  ValidateResult,
} from "./facade";

export {
  earlierFindings,
  isPreExisting,
  loadReviewMaterial,
  parseChangedLines,
  parseLocation,
  renderEarlierFindings,
  renderReviewPrompt,
} from "./review/index";
export type { ChangedLines, FindingLocation, ReviewMaterial } from "./review/index";
export {
  createFakeReviewCommandRunner,
  createReviewCommandRunner,
  createReviewer,
  FINDING_FORMAT,
  findingsJsonSchema,
  formatFixFeedback,
  parseFindings,
  parseReviewEvents,
  reaskArgv,
  REVIEW_COMMAND_RULE,
  REVIEW_INSTRUCTIONS_BYTES,
  reviewArgv,
  reviewInstructions,
  runReviewCommand,
} from "./review/index";
export type {
  FeedbackRecord,
  InvalidReview,
  RecordedReview,
  FakeReviewCommandRunner,
  ReviewCommandAgent,
  ReviewCommandOptions,
  ReviewCommandOutcome,
  ReviewCommandReply,
  ReviewCommandRequest,
  ReviewCommandResult,
  ReviewCommandRunner,
  ReviewerOptions,
  ReviewRunResult,
} from "./review/index";

export type { PawsCommandRunner, LoggedCommandRequest } from "./run/exec";
export {
  PROBE_TIMEOUT_SECONDS,
  executeProbe,
  probeArgv,
  probeArtifactPath,
  writeProbeLog,
} from "./run/probe";
export type { ProbeExecution, ProbeRunner, ProbeRunRequest, ProbeRunResult } from "./run/probe";
export type { CloseoutCommandPort } from "./run/run";
export {
  createCloseoutSession,
  type SessionCommandResult,
  type SessionRuleResult,
  type CloseoutSession,
  type CloseoutSessionOptions,
  type CloseoutSessionEvent,
  type CloseoutSessionCheck,
} from "./session";
