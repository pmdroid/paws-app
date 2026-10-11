import type { EvidenceRecord } from "./types";

export function evidenceAttemptKey(record: EvidenceRecord): string {
  return JSON.stringify([
    record.policyDigest,
    record.task ?? "",
    record.base,
    record.head,
    record.itemId,
    record.attempt,
  ]);
}
