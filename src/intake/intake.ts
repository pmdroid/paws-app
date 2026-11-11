import type { Database } from "bun:sqlite";
import type { IssueBrief } from "../core";
import { issueHasUnfinishedItemSteps, sqliteDb, type Q, type Steps } from "../db";
import { LinearIntakeRefusedError, type TrackerAdapter } from "../linear";
import type { DependencyEdge, EpicSnapshot } from "../linear";
import { orderByBlocks, type OrderNode } from "./order";
import {
  findAcceptedIntake,
  findAcceptedIntakeSteps,
  insertRunningQueueSteps,
  readAdoptedParentSteps,
  readEarlierAttemptSteps,
  retireEmptyFailedAttemptSteps,
} from "./store";
import type { EarlierAttempt, StoredDelegation, StoredWorkItem } from "./store";
import { ulid } from "./ulid";
import { snapshotProject } from "./project";

export type IntakeResult =
  | {
      ok: true;
      delegation: StoredDelegation;
      items: readonly StoredWorkItem[];
      alreadyExisted: boolean;
    }
  | {
      ok: false;
      reason: "cycle";
      delegation: StoredDelegation;
      identifiers: readonly string[];
      alreadyExisted: boolean;
    };

/** What GitHub holds for an earlier item's branch. */
export type EarlierBranch = {
  /** The state of the branch's latest pull request, or null when it never had one. */
  pull: "open" | "closed" | "merged" | null;
  /** Commits on the branch that main does not have. 0 when the branch is gone. */
  commits: number;
};

const FRESH_START = /\b(start(ing)?\s+(over\s+)?fresh|fresh\s+start)\b/i;

/** A delegation that asks for a fresh start gets a new branch even when earlier work exists. */
export function asksForFreshStart(text: string | null | undefined): boolean {
  return typeof text === "string" && FRESH_START.test(text);
}

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
    acknowledged?: boolean;
    isCurrent?: () => boolean | Promise<boolean>;
    onAccepted?: (q: Q, result: IntakeResult) => Steps<void>;
    beforeAdmit?: (q: Q) => Steps<void>;
    reconcileSessions?: (issueIds: readonly string[]) => Promise<void>;
    /** The delegation asked to start fresh: no earlier branch is continued. */
    startFresh?: boolean;
    /** Reads an earlier item's branch on GitHub. Without it every delegation starts fresh. */
    inspectBranch?: (earlier: EarlierAttempt) => Promise<EarlierBranch>;
    adoptParent?: (
      q: Q,
      sessionId: string,
      snapshot: EpicSnapshot,
      edges: readonly DependencyEdge[],
    ) => Steps<boolean>;
  },
): Promise<IntakeResult> {
  const store = sqliteDb(db);
  const now = input.now ?? Date.now();
  const taskKey = input.taskKey ?? `initial:${input.linearIssueId}`;
  const existing = await findAcceptedIntake(db, input.linearIssueId, taskKey);
  if (existing !== null) {
    const result = { ok: true as const, ...existing, alreadyExisted: true as const };
    if (input.onAccepted) await store.transaction((q) => input.onAccepted!(q, result));
    return result;
  }
  const loaded = await tracker.loadEpic(input.linearIssueId);
  const snapshot = input.singleIssue
    ? { ...loaded, subIssues: [] }
    : {
        ...loaded,
        subIssues: loaded.subIssues.filter(
          (issue) => !["completed", "canceled"].includes(issue.stateType ?? ""),
        ),
      };
  const delegatedAlone = snapshot.subIssues.length === 0;
  const nodes = workNodes(snapshot);
  const edges = await collectEdges(tracker, snapshot);
  const ordered = orderByBlocks(nodes, edges);
  if (input.isCurrent && !(await input.isCurrent()))
    throw new Error("Delegated intake was superseded");
  if (ordered.ok && (delegatedAlone || !input.adoptParent))
    await input.reconcileSessions?.(ordered.ordered.map((node) => node.linearIssueId));
  if (input.isCurrent && !(await input.isCurrent()))
    throw new Error("Delegated intake was superseded");
  const accepted = await findAcceptedIntake(db, input.linearIssueId, taskKey);
  if (accepted !== null) {
    const result = { ok: true as const, ...accepted, alreadyExisted: true as const };
    if (input.onAccepted) await store.transaction((q) => input.onAccepted!(q, result));
    return result;
  }
  const continuations =
    ordered.ok && !input.startFresh && input.inspectBranch
      ? await continuedBranches(db, ordered.ordered, input.inspectBranch)
      : new Map<string, EarlierAttempt>();
  if (input.isCurrent && !(await input.isCurrent()))
    throw new Error("Delegated intake was superseded");
  if (!ordered.ok) {
    const identifiers = ordered.remaining.map((node) => node.identifier);
    const result = {
      ok: false,
      reason: "cycle",
      delegation: {
        id: ulid(now),
        linearIssueId: snapshot.linearIssueId,
        linearIdentifier: snapshot.identifier,
        title: snapshot.title,
        state: "stalled",
        version: 0,
      },
      identifiers,
      alreadyExisted: false,
    } as const;
    if (input.onAccepted) await store.transaction((q) => input.onAccepted!(q, result));
    await announce(tracker, input.sessionId, "error", cycleMessage(identifiers));
    return result;
  }
  const sessionId = input.sessionId ?? "";
  let adopted = false;
  let existed = false;
  let result: IntakeResult;
  try {
    result = await store.transaction(function* (q) {
      const raced = yield* findAcceptedIntakeSteps(q, input.linearIssueId, taskKey);
      if (raced !== null) {
        existed = true;
        const admitted = { ok: true as const, ...raced, alreadyExisted: true as const };
        if (input.onAccepted) yield* input.onAccepted(q, admitted);
        return admitted;
      }
      if (input.beforeAdmit) yield* input.beforeAdmit(q);
      if (
        snapshot.subIssues.length > 0 &&
        sessionId.length > 0 &&
        input.adoptParent &&
        (yield* input.adoptParent(q, sessionId, snapshot, edges))
      ) {
        adopted = true;
        const delegation = yield* readAdoptedParentSteps(q, snapshot.linearIssueId);
        if (delegation === null) throw new Error("Adopted parent was not recorded");
        const admitted = {
          ok: true,
          delegation,
          items: [],
          alreadyExisted: false,
        } as const;
        if (input.onAccepted) yield* input.onAccepted(q, admitted);
        return admitted;
      }
      if (delegatedAlone && sessionId.length > 0)
        yield* retireEmptyFailedAttemptSteps(q, snapshot.linearIssueId, sessionId);
      const conflict = yield* activeElsewhereSteps(q, ordered.ordered);
      if (conflict) throw new ActiveIssueError(conflict.identifier);
      const saved = yield* insertRunningQueueSteps(q, {
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
        projects: new Map(
          (delegatedAlone ? [snapshot] : snapshot.subIssues).map((issue) => [
            issue.linearIssueId,
            snapshotProject(issue) ?? null,
          ]),
        ),
        edges,
        now,
        sessionKey: sessionId.length > 0 ? sessionId : null,
        continuations,
      });
      const admitted = {
        ok: true,
        delegation: saved.delegation,
        items: saved.items,
        alreadyExisted: false,
      } as const;
      if (input.onAccepted) yield* input.onAccepted(q, admitted);
      return admitted;
    });
  } catch (error) {
    if (error instanceof ActiveIssueError) {
      await announce(tracker, input.sessionId, "error", error.message);
    }
    throw error;
  }
  // An adopted parent answers once, with a summary, after its sub-issue sessions open.
  if (existed || adopted || (delegatedAlone && input.acknowledged)) return result;
  await announce(
    tracker,
    input.sessionId,
    "thought",
    queueMessage(
      result.items.map((item) => item.linearIdentifier),
      delegatedAlone,
    ),
  );
  return result;
}

export class ActiveIssueError extends LinearIntakeRefusedError {
  constructor(identifier: string) {
    super(
      `${identifier} has an unfinished attempt in another Paws session. Reply in that session to continue, or stop it before starting a new one.`,
      { quiet: true },
    );
  }
}

function* activeElsewhereSteps(q: Q, nodes: readonly OrderNode[]): Steps<OrderNode | undefined> {
  for (const node of nodes)
    if (yield* issueHasUnfinishedItemSteps(q, node.linearIssueId)) return node;
  return undefined;
}

/**
 * The earlier item each issue continues: one with an open pull request, or whose unmerged branch
 * holds commits main does not have. An issue with unfinished work elsewhere is refused at admission,
 * so its branch is not read.
 */
async function continuedBranches(
  db: Database,
  nodes: readonly OrderNode[],
  inspect: (earlier: EarlierAttempt) => Promise<EarlierBranch>,
): Promise<Map<string, EarlierAttempt>> {
  const store = sqliteDb(db);
  const continued = new Map<string, EarlierAttempt>();
  if (await store.run((q) => activeElsewhereSteps(q, nodes))) return continued;
  for (const node of nodes) {
    const earlier = await store.run((q) => readEarlierAttemptSteps(q, node.linearIssueId));
    if (earlier === null) continue;
    const branch = await inspect(earlier);
    // A squash merge leaves the branch's own commits outside main; merged work is not continued.
    if (branch.pull === "open" || (branch.pull !== "merged" && branch.commits > 0))
      continued.set(node.linearIssueId, earlier);
  }
  return continued;
}

function issueBrief(issue: {
  linearIssueId: string;
  identifier: string;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
}): IssueBrief {
  return {
    source: "linear",
    issueId: issue.linearIssueId,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    acceptanceCriteria: issue.acceptanceCriteria ?? null,
  };
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
