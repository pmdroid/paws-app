import {
  filedIssueOriginsSteps,
  itemFiledIssuesSteps,
  listWorkItemFactsSteps,
  listItemPullRequestsSteps,
  listWorkItemsByStatesSteps,
  type Db,
  type ItemPullRequest,
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
  const shown = rows.flatMap((row) => {
    const item = byIssue.get(row.linearIssueId);
    return item !== undefined && visible(item) ? [item.id] : [];
  });
  const pulls = new Map(
    (await store.run((q) => listItemPullRequestsSteps(q, shown))).map((pull) => [
      pull.itemId,
      pull,
    ]),
  );
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
      ...pullFor(item === undefined ? undefined : pulls.get(item.id), item?.state),
    });
  }
  const origins = await store.run((q) => filedIssueOriginsSteps(q, records[0]!.linearIssueId));
  const originId = origins.find((row) => !own.has(row.itemId))?.itemId;
  const filedFrom = all.find((record) => record.id === originId);
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

function pullFor(
  pull: ItemPullRequest | undefined,
  state: WorkItemRecord["state"] | undefined,
): Pick<StatusFollowUp, "pull"> {
  if (pull?.pullUrl == null) return {};
  return {
    pull: {
      number: pull.pullNumber,
      url: pull.pullUrl,
      state: state === "merged" ? "merged" : state === "cancelled" ? "closed" : "open",
    },
  };
}
