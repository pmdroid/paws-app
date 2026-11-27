import { journal } from "../journal";

const unreadable = new Set<string>();

export function parseRetroEvidenceRef(ref: string): { retroId: string; evidenceId: string } | null {
  const match = /^retro:([^:]+):(.+)$/s.exec(ref);
  if (match) return { retroId: match[1]!, evidenceId: match[2]! };
  if (!unreadable.has(ref)) {
    unreadable.add(ref);
    journal(`improvements: skipped unreadable retro evidence reference ${JSON.stringify(ref)}`);
  }
  return null;
}
