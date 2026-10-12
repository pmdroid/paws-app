import type { Database } from "bun:sqlite";
import type { IssueBrief } from "../core";
import type { TrackerAdapter } from "../linear";
import type { DependencyEdge, EpicSnapshot } from "../linear";
import { orderByBlocks, type OrderNode } from "./order";
import { insertRunningQueue, insertStalledEpic, listWorkItems, readEpicByLinearId } from "./store";
import type { StoredEpic, StoredWorkItem } from "./store";

export type IntakeResult =
  | {
      ok: true;
      epic: StoredEpic;
      items: readonly StoredWorkItem[];
      alreadyExisted: boolean;
    }
  | {
      ok: false;
      reason: "cycle";
      epic: StoredEpic;
      identifiers: readonly string[];
      alreadyExisted: boolean;
    };

export function queueMessage(identifiers: readonly string[], delegatedAlone: boolean): string {
  if (delegatedAlone) {
    const identifier = identifiers[0] ?? "this issue";
    return `Picked up ${identifier}.`;
  }
  const noun = identifiers.length === 1 ? "sub-issue" : "sub-issues";
  return `Picked up ${identifiers.length} ${noun}; order: ${identifiers.join(" → ")}`;
}

export function cycleMessage(identifiers: readonly string[]): string {
  return `Cycle in blocks relations (${identifiers.join(" → ")}). Nothing will run.`;
}

/**
 * Load a delegated issue. A parent with sub-issues becomes an ordered queue;
 * a lone issue is a queue of one. A blocks cycle is reported and nothing is queued.
 */
export async function intakeDelegatedIssue(
  db: Database,
  tracker: TrackerAdapter,
  input: {
    linearIssueId: string;
    sessionId?: string | null;
    now?: number;
    taskKey?: string;
    singleIssue?: boolean;
  },
): Promise<IntakeResult> {
  const now = input.now ?? Date.now();
  const taskKey = input.taskKey ?? `initial:${input.linearIssueId}`;
  const existing = readEpicByLinearId(db, input.linearIssueId, taskKey);
  if (existing !== null) return replay(db, existing);
  const loaded = await tracker.loadEpic(input.linearIssueId);
  const snapshot = input.singleIssue ? { ...loaded, subIssues: [] } : loaded;
  const delegatedAlone = snapshot.subIssues.length === 0;
  const nodes = workNodes(snapshot);
  const edges = await collectEdges(tracker, snapshot);
  const ordered = orderByBlocks(nodes, edges);
  if (!ordered.ok) {
    const epic = insertStalledEpic(db, {
      taskKey,
      linearIssueId: snapshot.linearIssueId,
      identifier: snapshot.identifier,
      title: snapshot.title,
      now,
    });
    const identifiers = ordered.remaining.map((node) => node.identifier);
    await announce(tracker, input.sessionId, "error", cycleMessage(identifiers));
    return { ok: false, reason: "cycle", epic, identifiers, alreadyExisted: false };
  }
  const saved = insertRunningQueue(db, {
    taskKey,
    linearIssueId: snapshot.linearIssueId,
    identifier: snapshot.identifier,
    title: snapshot.title,
    ordered: ordered.ordered,
    briefs: new Map(
      (delegatedAlone ? [snapshot] : snapshot.subIssues).map((issue) => [
        issue.linearIssueId,
        { issue: issueBrief(issue), epic: delegatedAlone ? null : issueBrief(snapshot) },
      ]),
    ),
    edges,
    now,
  });
  await announce(
    tracker,
    input.sessionId,
    "thought",
    queueMessage(
      saved.items.map((item) => item.linearIdentifier),
      delegatedAlone,
    ),
  );
  return { ok: true, epic: saved.epic, items: saved.items, alreadyExisted: false };
}

function issueBrief(issue: {
  linearIssueId: string;
  identifier: string;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
}): IssueBrief {
  return {
    source: issue.linearIssueId.startsWith("github:") ? "github" : "linear",
    issueId: issue.linearIssueId,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    acceptanceCriteria: issue.acceptanceCriteria ?? null,
  };
}

function replay(db: Database, epic: StoredEpic): IntakeResult {
  const items = listWorkItems(db, epic.id);
  if (epic.state === "stalled" && items.length === 0) {
    return { ok: false, reason: "cycle", epic, identifiers: [], alreadyExisted: true };
  }
  return { ok: true, epic, items, alreadyExisted: true };
}

function workNodes(snapshot: EpicSnapshot): OrderNode[] {
  if (snapshot.subIssues.length === 0) {
    return [
      {
        linearIssueId: snapshot.linearIssueId,
        identifier: snapshot.identifier,
        title: snapshot.title,
      },
    ];
  }
  return snapshot.subIssues.map((issue) => ({
    linearIssueId: issue.linearIssueId,
    identifier: issue.identifier,
    title: issue.title,
  }));
}

async function collectEdges(
  tracker: TrackerAdapter,
  snapshot: EpicSnapshot,
): Promise<DependencyEdge[]> {
  const ids = [snapshot.linearIssueId, ...snapshot.subIssues.map((issue) => issue.linearIssueId)];
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const edge of await tracker.listDeps(id)) {
      const key = `${edge.blockerLinearIssueId}|${edge.blockedLinearIssueId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
  }
  return edges;
}

async function announce(
  tracker: TrackerAdapter,
  sessionId: string | null | undefined,
  kind: "thought" | "error",
  body: string,
): Promise<void> {
  if (sessionId === null || sessionId === undefined || sessionId.length === 0) return;
  await tracker.postProgress({ sessionId, kind, body });
}
