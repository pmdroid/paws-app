/**
 * One proposed sub-issue from a plan run. `blockedBy` holds the positions of
 * earlier drafts in the same proposal that must merge first.
 */
export type SubIssueDraft = {
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  blockedBy: readonly number[];
};

/** One sub-issue the tracker filed for a draft, in draft order. */
export type FiledSubIssue = { id: string; identifier: string; url: string | null };

export const MAX_SUB_ISSUE_DRAFTS = 12;

/**
 * Check drafts from a plan run or from storage. Titles are one line, every
 * draft names at least one acceptance criterion, and `blockedBy` only points
 * at earlier drafts, so the blocks order has no cycle.
 */
export function validateSubIssueDrafts(value: unknown): SubIssueDraft[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("A plan proposes at least one sub-issue");
  if (value.length > MAX_SUB_ISSUE_DRAFTS)
    throw new Error(`A plan proposes at most ${MAX_SUB_ISSUE_DRAFTS} sub-issues`);
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Sub-issue ${index + 1} is not an object`);
    const draft = entry as Record<string, unknown>;
    const title = typeof draft.title === "string" ? draft.title.trim() : "";
    if (!title || title.length > 255 || /[\r\n]/.test(title))
      throw new Error(`Sub-issue ${index + 1} needs a one-line title`);
    const description = typeof draft.description === "string" ? draft.description.trim() : "";
    const criteria = draft.acceptanceCriteria;
    if (
      !Array.isArray(criteria) ||
      criteria.length === 0 ||
      criteria.some((line) => typeof line !== "string" || !line.trim())
    )
      throw new Error(`Sub-issue ${index + 1} needs acceptance criteria`);
    const blockedBy = draft.blockedBy ?? [];
    if (
      !Array.isArray(blockedBy) ||
      blockedBy.some((position) => !Number.isInteger(position) || position < 0 || position >= index)
    )
      throw new Error(`Sub-issue ${index + 1} can only be blocked by earlier sub-issues`);
    return {
      title,
      description,
      acceptanceCriteria: criteria.map((line: string) => line.trim()),
      blockedBy: [...new Set(blockedBy as number[])].sort((left, right) => left - right),
    };
  });
}
