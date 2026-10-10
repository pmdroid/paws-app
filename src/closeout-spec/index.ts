/**
 * Closeout draft 0.1 seam.
 *
 * Public surface is the frozen types plus the spec pin (`SPEC_VERSION`,
 * `SPEC_COMMIT`). The review port is re-exported from `./review` so other
 * modules reach it through this index. Policy loading, command execution,
 * and the acceptance decision stay in their own modules and import these types.
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

export { createReviewer, formatFixFeedback } from "./review/index";
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
