import {
  itemFiledIssuesSteps,
  listWorkItemFactsSteps,
  listWorkItemsByStatesSteps,
  type Db,
  type WorkItemRecord,
} from "../../../db";
import { dashboardIssuePath } from "../../../dashboard-links";
import type { StatusFiledFrom, StatusFollowUp } from "../contract";
import {
  itemState,
  latestByLinearIssue,
  publicId,
  WORK_ITEM_STATES,
  type LiveStatusOptions,
} from "./provider";

export async function followUpsFor(
  store: Db,
  options: LiveStatusOptions,
  records: readonly WorkItemRecord[],
): Promise<{ followUps: StatusFollowUp[]; filedFrom?: StatusFiledFrom }> {
  if (records.length === 0) return { followUps: [] };
  const all = await store.run((q) => listWorkItemsByStatesSteps(q, WORK_ITEM_STATES));
  const facts = new Map(
    (await store.run(listWorkItemFactsSteps)).map((fact) => [fact.itemId, fact]),
  );
  const visible = (record: WorkItemRecord) =>
    options.sessionIds === undefined ||
    (record.sessionKey !== null && options.sessionIds.includes(record.sessionKey));
  const byIssue = latestByLinearIssue(all, facts);
  const own = new Set(records.map((record) => record.id));
  const rows = [];
  for (const record of records)
    rows.push(...(await store.run((q) => itemFiledIssuesSteps(q, record.id))));
  const seen = new Set<string>();
  const followUps: StatusFollowUp[] = [];
  for (const row of rows.sort((left, right) => left.filedAt - right.filedAt)) {
    if (seen.has(row.linearIssueId)) continue;
    seen.add(row.linearIssueId);
    const item = byIssue.get(row.linearIssueId);
    if (item !== undefined && !visible(item)) {
      followUps.push({ identifier: publicId(item) });
      continue;
    }
    followUps.push({
      identifier: row.identifier,
      title: row.title,
      url: row.url,
      started: row.started,
      ...(item === undefined
        ? {}
        : { state: itemState(item.state), path: dashboardIssuePath(publicId(item)) }),
    });
  }
  const filedFrom = await originOf(store, records, all, own, facts);
  if (filedFrom === undefined) return { followUps };
  return {
    followUps,
    filedFrom: visible(filedFrom)
      ? {
          identifier: publicId(filedFrom),
          title: filedFrom.title?.trim() || publicId(filedFrom),
          path: dashboardIssuePath(publicId(filedFrom)),
        }
      : { identifier: publicId(filedFrom) },
  };
}

async function originOf(
  store: Db,
  records: readonly WorkItemRecord[],
  all: readonly WorkItemRecord[],
  own: ReadonlySet<string>,
  facts: ReadonlyMap<string, { createdAt: number }>,
): Promise<WorkItemRecord | undefined> {
  const createdAt = (record: WorkItemRecord) => facts.get(record.id)?.createdAt ?? 0;
  const before = Math.min(...records.map(createdAt));
  const candidates = all
    .filter((record) => !own.has(record.id) && createdAt(record) <= before)
    .sort((left, right) => createdAt(right) - createdAt(left));
  for (const candidate of candidates) {
    const rows = await store.run((q) => itemFiledIssuesSteps(q, candidate.id));
    if (rows.some((row) => row.linearIssueId === records[0]!.linearIssueId)) return candidate;
  }
  return undefined;
}
