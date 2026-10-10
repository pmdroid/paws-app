/**
 * Closeout evidence on disk.
 *
 * Records and logs use the reference runner's layout relative to this root,
 * which for Paws is `~/.paws/closeout/<owner>/<repo>/`.
 */

export { evidenceRoot } from "./layout";
export { createEvidenceStore } from "./store";
export type { AttemptKey, EvidenceStoreOptions, LogWrite, PawsEvidenceStore } from "./store";
