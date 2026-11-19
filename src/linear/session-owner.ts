import {
  delegatedLinearUserIdSteps,
  getLinearSessionSteps,
  listWorkItemsSteps,
  slackIssueOwnerSteps,
  type Db,
} from "../db";
import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";

export async function followUpSessionOwner(
  store: Db,
  tracker: TrackerAdapter,
  issueId: string,
  organizationId: string,
  appUserId: string,
  options?: TrackerRequestOptions,
): Promise<string | null> {
  const brief = await tracker.readBriefIssue?.(issueId, options);
  if (brief?.issue.issueId !== issueId || brief.creatorId !== appUserId) return null;
  if (!brief.parent) return store.run((q) => slackIssueOwnerSteps(q, issueId, organizationId));
  const parentId = brief.parent.issueId;
  return store.run(function* (q) {
    const items = yield* listWorkItemsSteps(q);
    for (const item of items.toReversed()) {
      if (item.linearIssueId !== parentId || !item.sessionKey) continue;
      const session = yield* getLinearSessionSteps(q, item.sessionKey);
      if (session?.organizationId !== organizationId) continue;
      return yield* delegatedLinearUserIdSteps(q, item.id);
    }
    return null;
  });
}
