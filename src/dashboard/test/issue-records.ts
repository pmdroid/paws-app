import type { IssueDetailResponse, IssueListResponse } from "../src/contract";

type IssueReader = {
  issues(): Promise<IssueListResponse>;
  issue(id: string): Promise<IssueDetailResponse | null>;
};

export async function issueRecords(provider: IssueReader) {
  const list = await provider.issues();
  const details: IssueDetailResponse[] = [];
  for (const id of new Set(list.issues.map((row) => row.id))) {
    const detail = await provider.issue(id);
    if (detail) details.push(JSON.parse(JSON.stringify(detail)) as IssueDetailResponse);
  }
  const unique = <T>(entries: T[], key: (entry: T) => string) => [
    ...new Map(entries.map((entry) => [key(entry), entry])).values(),
  ];
  return {
    ...list,
    issues: details.flatMap((detail) => [detail.issue, ...detail.earlierSessions]),
    runs: unique(
      details.flatMap((detail) => detail.runs),
      (run) => run.id,
    ),
    verdicts: unique(
      details.flatMap((detail) => detail.verdicts),
      (verdict) => `${verdict.itemId}:${verdict.runId ?? ""}`,
    ),
    agentCloseout: unique(
      details.flatMap((detail) => detail.agentCloseout),
      (entry) => entry.runId,
    ),
  };
}
