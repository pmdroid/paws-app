/**
 * Closeout videos and screenshots on the Paws host, under `~/.paws/evidence`.
 *
 * Each file has a row in the `evidence` table. `GET /api/evidence/:id` serves it to signed-in
 * members whose Linear sessions include the evidence's work item, which is how the workspace's
 * repository-to-team mapping reaches the request.
 */

export { createEvidenceStore, EVIDENCE_LIMITS, EvidenceRejectedError, evidencePath } from "./store";
export type { EvidenceInput, EvidenceLimits, EvidenceStore, EvidenceStoreOptions } from "./store";
export { EVIDENCE_API_PATH, handleEvidenceRequest, parseRange } from "./route";
export type { EvidenceRequestOptions } from "./route";
export { sniffMedia } from "./media";
