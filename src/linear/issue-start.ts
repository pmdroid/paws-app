export type IssueStartReads = Map<
  string,
  { at: number; data: unknown; unread: Set<"epic" | "deps" | "merge"> }
>;

const START_READ_MS = 5 * 60_000;

export function keepIssueStart(reads: IssueStartReads, issueId: string, data: unknown): void {
  for (const [id, read] of reads) if (Date.now() - read.at > START_READ_MS) reads.delete(id);
  reads.set(issueId, { at: Date.now(), data, unread: new Set(["epic", "deps", "merge"]) });
}

export function takeIssueStart(
  reads: IssueStartReads | undefined,
  issueId: string,
  use: "epic" | "deps" | "merge",
): unknown {
  const read = reads?.get(issueId);
  if (read === undefined || Date.now() - read.at > START_READ_MS || !read.unread.delete(use))
    return undefined;
  if (read.unread.size === 0) reads!.delete(issueId);
  return read.data;
}
