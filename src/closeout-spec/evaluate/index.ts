/**
 * Closeout draft 0.1 acceptance decision.
 *
 * `evaluate` is a pure function. Policy loading, command execution, and
 * review intake stay outside this module and pass their results in.
 */

export { evaluate, decisionExit, INVALID_INVOCATION_EXIT } from "./evaluate";
export type { EvaluateRequest } from "./evaluate";

export {
  CLOSEOUT_REFERENCE_NAME,
  CLOSEOUT_REFERENCE_VERSION,
  PAWS_CLOSEOUT_NAME,
  PAWS_CLOSEOUT_VERSION,
  producerTrusted,
  trustedProducers,
} from "./trust";
export type { EvaluateTrust, TrustedProducer } from "./trust";
