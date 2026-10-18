/**
 * Closeout videos and screenshots under `~/.paws/evidence`, one `evidence` row each,
 * served by `GET /api/evidence/:id` to members who can see the repository.
 */

export { sniffMediaType } from "./sniff";
export { createEvidenceMediaStore, DEFAULT_EVIDENCE_LIMITS, EvidenceRefusedError } from "./store";
export type {
  EvidenceLimits,
  EvidenceMediaStore,
  EvidenceMediaStoreOptions,
  EvidenceRefusal,
  SaveEvidence,
} from "./store";
export { EVIDENCE_PATH_PREFIX, handleEvidenceRequest, parseRange } from "./http";
export type { EvidenceRequestOptions } from "./http";
