export { FINDING_FORMAT, parseFindings, scrubText } from "../closeout-spec";
export {
  approvalsAtHead,
  reviewRequirements,
  trustedPolicyFiles,
  trustedRootFiles,
  visualReviewRequirements,
} from "../closeout-spec";
export type { RootFilesLoad } from "../closeout-spec";
export { createFakeCloseoutGate } from "./fake";
export type { FakeCloseoutGate } from "./fake";
export { awaitsVisualReview, createCloseoutGate } from "./gate";
export type { CloseoutDecision, CloseoutGate, CloseoutRunInput, CloseoutVerdict } from "./gate";
export type { CloseoutGateOptions } from "./gate";
export type { FixRequest, FixResult, FixRunner } from "./fixer";
export type { VerdictRecorder } from "./report";
export { writeVerdictReport } from "./report";
export type { CodexReviewer, ReviewRequest, ReviewResult } from "./reviewer";
export { evaluateCandidate, evidenceOnly, runCloseoutGate, snapshotRetryBaseline } from "./run";
export {
  CloseoutResultMissingError,
  loggedSessionCloseout,
  readSessionCloseout,
  sessionCloseoutAccepted,
  sessionCloseoutPath,
  sessionCloseoutResult,
  writeSessionCloseout,
} from "./session-report";
export type { EvaluateInput, Evaluation, GateInput } from "./run";
export type {
  CloseoutOutputStream,
  CloseoutProgress,
  CloseoutProgressIdentity,
  CloseoutProgressStep,
  CloseoutStepKind,
  CloseoutStepState,
  EvidenceApproval,
  PublishedEvidence,
  ResolvedEvidence,
} from "../closeout-spec";
export { formatEvidenceSummary, formatFixFeedback } from "./summary";
export { MAX_FIX_ATTEMPTS } from "./types";
export type {
  CandidateIdentity,
  DecisionDocument,
  Finding,
  GateOutcome,
  GateResult,
} from "./types";

export { bypassable } from "./bypass";
export type { CloseoutBypass } from "./bypass";
