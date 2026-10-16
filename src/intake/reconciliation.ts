import type { Database } from "bun:sqlite";
import type { IssueBrief, WorkBrief } from "../core";
import type { EpicSnapshot, LinearIssueLifecycle, LinearSubIssue, TrackerAdapter } from "../linear";
import { readyItems, syncItemDependencies } from "./dependencies";
import { ulid } from "./ulid";
import type { InspectBlockerMerge } from "./blocker-policy";

export type EpicChanges = {
  epicId: string;
  workspaceId: string;
  sessionId: string;
  addedItemIds: string[];
  removedItemIds: string[];
  specChangedItemIds: string[];
  canceledItemIds: string[];
  parentCanceled: boolean;
  issues: { itemId: string; issue: LinearSubIssue }[];
};

type Target = { epicId: string; workspaceId: string; signal?: AbortSignal };
type IssueChange = { issueId: string; organizationId: string; parentIssueId?: string | null };
type Identity = {
  issueId: string;
  sessionId: string;
  organizationId: string;
  teamId: string;
  appUserId: string;
  clientId: string;
  creatorId: string | null;
  actorId: string | null;
  generation: number;
  taskKey: string | null;
};
type Item = {
  id: string;
  issueId: string;
  brief: string | null;
  hash: string | null;
  revision: number | null;
  present: number | null;
};

function authority(db: Database, target: Target) {
  const identity = db
    .query<Identity, [string, string]>(
      `SELECT e.linear_issue_id AS issueId,e.task_key AS taskKey,s.session_id AS sessionId,
       s.organization_id AS organizationId,s.team_id AS teamId,s.app_user_id AS appUserId,
       s.oauth_client_id AS clientId,s.creator_id AS creatorId,
       COALESCE((SELECT u.linear_user_id FROM workspace_user u
         JOIN work_item oi ON oi.owner_user_id=u.id
         WHERE oi.epic_id=e.id AND oi.session_key=s.session_id
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1),
       (SELECT oi.delegated_by FROM work_item oi
         WHERE oi.epic_id=e.id AND oi.session_key=s.session_id AND oi.delegated_by IS NOT NULL
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1), s.creator_id) AS actorId,
       s.generation FROM epic e
       JOIN linear_session s ON s.session_id=(
         SELECT i.session_key FROM work_item i
         JOIN linear_session ls ON ls.session_id=i.session_key AND ls.stopped_at IS NULL
         WHERE i.epic_id=e.id
         ORDER BY i.created_at, i.position, i.id LIMIT 1)
       JOIN workspace w ON w.linear_organization_id=s.organization_id
       WHERE e.id=? AND w.id=? AND e.state IN ('running','stalled')
       AND s.stopped_at IS NULL
       AND s.team_id IS NOT NULL AND s.app_user_id IS NOT NULL AND s.oauth_client_id IS NOT NULL`,
    )
    .get(target.epicId, target.workspaceId);
  if (!identity) throw new Error("Epic reconciliation authority changed");
  const items = db
    .query<Item, [string]>(
      `SELECT i.id,i.linear_issue_id AS issueId,i.brief,p.hash,p.revision,p.present
       FROM work_item i LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.epic_id=? ORDER BY i.id`,
    )
    .all(target.epicId);
  const active = items.filter((item) => item.present !== 0);
  if (new Set(active.map((item) => item.issueId)).size !== active.length)
    throw new Error("Epic reconciliation item identities are ambiguous");
  return { identity, items, token: JSON.stringify([identity, items]) };
}

function brief(issue: LinearSubIssue | EpicSnapshot): IssueBrief {
  return {
    source: "linear",
    issueId: issue.linearIssueId,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    acceptanceCriteria: issue.acceptanceCriteria ?? null,
  };
}

function specHash(value: WorkBrief): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createEpicReconciler(input: {
  db: Database;
  tracker: Pick<TrackerAdapter, "loadEpic" | "listDeps" | "listIssuePullRequests">;
  lifecycle: Pick<LinearIssueLifecycle, "inspect">;
  inspectMerge?: InspectBlockerMerge;
  onChanges: (changes: EpicChanges) => void;
  afterChanges?: (changes: EpicChanges) => Promise<void>;
  scopeSnapshot?: (
    sessionId: string,
    snapshot: EpicSnapshot,
    signal?: AbortSignal,
  ) => Promise<EpicSnapshot>;
  now?: () => number;
}) {
  const { db, tracker, lifecycle } = input;
  const flights = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  let lastSweep: number | null = null;
  let sweepFlight: Promise<void> | null = null;
  const now = input.now ?? Date.now;
  const shutdown = new AbortController();
  let closing: Promise<void> | null = null;

  async function refresh(target: Target, requestToken: string) {
    target.signal?.throwIfAborted();
    const initial = authority(db, target);
    const loaded = await tracker.loadEpic(initial.identity.issueId);
    const snapshot = input.scopeSnapshot
      ? await input.scopeSnapshot(initial.identity.sessionId, loaded, target.signal)
      : loaded;
    target.signal?.throwIfAborted();
    if (snapshot.linearIssueId !== initial.identity.issueId)
      throw new Error("Linear returned another epic");
    const single = initial.items.every((item) => item.issueId === initial.identity.issueId);
    const issues = snapshot.subIssues.length ? snapshot.subIssues : single ? [snapshot] : [];
    if (new Set(issues.map((issue) => issue.linearIssueId)).size !== issues.length)
      throw new Error("Linear returned repeated sub-issues");
    const statuses = new Map<string, string>();
    for (const id of new Set([
      snapshot.linearIssueId,
      ...issues.map((issue) => issue.linearIssueId),
    ])) {
      const owned = await lifecycle.inspect(id, { signal: target.signal });
      if (owned.id !== id || owned.teamId !== initial.identity.teamId)
        throw new Error("Linear epic or child team changed");
      statuses.set(id, owned.stateType);
    }
    target.signal?.throwIfAborted();
    const publication = db
      .transaction(() => {
        if (authority(db, target).token !== initial.token)
          throw new Error("Epic reconciliation authority changed");
        if (
          db
            .query<{ token: string }, [string]>(
              "SELECT token FROM epic_reconciliation_request WHERE epic_id=?",
            )
            .get(target.epicId)?.token !== requestToken
        )
          return null;
        const change: EpicChanges = {
          epicId: target.epicId,
          workspaceId: target.workspaceId,
          sessionId: initial.identity.sessionId,
          addedItemIds: [],
          removedItemIds: [],
          specChangedItemIds: [],
          canceledItemIds: [],
          parentCanceled: statuses.get(snapshot.linearIssueId) === "canceled",
          issues: [],
        };
        const desired = new Set(issues.map((issue) => issue.linearIssueId));
        for (const item of initial.items) {
          if (!desired.has(item.issueId) && item.present !== 0) change.removedItemIds.push(item.id);
          if (!desired.has(item.issueId))
            db.run(
              `INSERT INTO work_item_specification(item_id,hash,revision,present) VALUES(?,?,1,0)
               ON CONFLICT(item_id) DO UPDATE SET present=0`,
              [item.id, item.hash ?? specHash(JSON.parse(item.brief ?? "null"))],
            );
        }
        const byIssue = new Map(
          initial.items.filter((item) => item.present !== 0).map((item) => [item.issueId, item]),
        );
        for (const [position, issue] of issues.entries()) {
          const workBrief: WorkBrief = {
            issue: brief(issue),
            epic: issue.linearIssueId === snapshot.linearIssueId ? null : brief(snapshot),
          };
          const hash = specHash(workBrief);
          const existing = byIssue.get(issue.linearIssueId);
          const id = existing?.id ?? ulid(now() + position);
          if (!existing) {
            const previousOccurrences = initial.items.filter(
              (item) => item.issueId === issue.linearIssueId,
            ).length;
            const reappearance = previousOccurrences ? `:reappearance:${previousOccurrences}` : "";
            db.run(
              `INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,
               branch_name,position,version,created_at,brief,task_key,session_key)
               VALUES(?,?,?,?,?,'queued',?,?,0,?,?,?,?)`,
              [
                id,
                target.epicId,
                issue.linearIssueId,
                issue.identifier,
                issue.title,
                `paws/${issue.identifier.toLowerCase()}${previousOccurrences ? `-r${previousOccurrences}` : ""}`,
                position,
                now(),
                JSON.stringify(workBrief),
                `${initial.identity.taskKey ?? `initial:${snapshot.linearIssueId}`}:item:${issue.linearIssueId}${reappearance}`,
                initial.identity.sessionId,
              ],
            );
            change.addedItemIds.push(id);
          } else {
            const previous = existing.hash ?? specHash(JSON.parse(existing.brief ?? "null"));
            if (previous !== hash) change.specChangedItemIds.push(id);
            db.run(
              "UPDATE work_item SET brief=?,title=?,linear_identifier=?,position=? WHERE id=?",
              [JSON.stringify(workBrief), issue.title, issue.identifier, position, id],
            );
          }
          db.run(
            `INSERT INTO work_item_specification(item_id,hash,revision,present) VALUES(?,?,1,1)
             ON CONFLICT(item_id) DO UPDATE SET hash=excluded.hash,
             revision=work_item_specification.revision+(work_item_specification.hash<>excluded.hash),present=1`,
            [id, hash],
          );
          change.issues.push({ itemId: id, issue });
          if (change.parentCanceled || statuses.get(issue.linearIssueId) === "canceled")
            change.canceledItemIds.push(id);
        }
        db.run("UPDATE epic SET title=?,linear_identifier=? WHERE id=?", [
          snapshot.title,
          snapshot.identifier,
          target.epicId,
        ]);
        if (
          change.addedItemIds.length ||
          change.removedItemIds.length ||
          change.specChangedItemIds.length
        )
          db.run(
            "UPDATE item_dependency_snapshot SET scope='[]' WHERE item_id IN (SELECT id FROM work_item WHERE epic_id=?)",
            [target.epicId],
          );
        for (const [kind, ids] of [
          ["spec", change.specChangedItemIds],
          ["removed", change.removedItemIds],
          ["canceled", change.canceledItemIds],
        ] as const)
          for (const id of ids)
            db.run(
              `INSERT INTO epic_reconciliation_effect(epic_id,item_id,kind,token) VALUES(?,?,?,?)
               ON CONFLICT(epic_id,item_id,kind) DO UPDATE SET token=excluded.token`,
              [target.epicId, id, kind, crypto.randomUUID()],
            );
        input.onChanges({ ...change });
        const effects = db
          .query<{ itemId: string; kind: string; token: string }, [string]>(
            "SELECT item_id AS itemId,kind,token FROM epic_reconciliation_effect WHERE epic_id=?",
          )
          .all(target.epicId);
        change.specChangedItemIds = effects
          .filter((effect) => effect.kind === "spec")
          .map((effect) => effect.itemId);
        change.removedItemIds = effects
          .filter((effect) => effect.kind === "removed")
          .map((effect) => effect.itemId);
        change.canceledItemIds = effects
          .filter((effect) => effect.kind === "canceled")
          .map((effect) => effect.itemId);
        return { change, effects };
      })
      .immediate();
    if (publication === null) return;
    const changes = publication.change;
    await input.afterChanges?.(changes);
    target.signal?.throwIfAborted();
    if (!changes.parentCanceled) {
      const itemIds = db
        .query<{ id: string }, [string]>(
          `SELECT i.id FROM work_item i LEFT JOIN work_item_specification p ON p.item_id=i.id
           WHERE i.epic_id=? AND COALESCE(p.present,1)=1 ORDER BY i.position,i.id`,
        )
        .all(target.epicId)
        .map((item) => item.id);
      for (const itemId of itemIds)
        await syncItemDependencies(db, {
          itemId,
          workspaceId: target.workspaceId,
          expectedGeneration: readyItems(db, { itemId, workspaceId: target.workspaceId })
            .generation,
          tracker,
          lifecycle,
          inspectMerge: input.inspectMerge,
          signal: target.signal,
        });
    }
    db.transaction(() => {
      db.run(
        "DELETE FROM epic_reconciliation_request WHERE epic_id=? AND workspace_id=? AND token=?",
        [target.epicId, target.workspaceId, requestToken],
      );
      for (const effect of publication.effects)
        db.run(
          "DELETE FROM epic_reconciliation_effect WHERE epic_id=? AND item_id=? AND kind=? AND token=?",
          [target.epicId, effect.itemId, effect.kind, effect.token],
        );
    }).immediate();
  }

  function waitForFlight(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  function reconcile(target: Target): Promise<void> {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason);
    if (target.signal?.aborted) return Promise.reject(target.signal.reason);
    try {
      db.transaction(() => {
        authority(db, target);
        const accepted = db.run(
          `INSERT INTO epic_reconciliation_request(epic_id,workspace_id,token) VALUES(?,?,?)
           ON CONFLICT(epic_id) DO UPDATE SET token=excluded.token
           WHERE epic_reconciliation_request.workspace_id=excluded.workspace_id`,
          [target.epicId, target.workspaceId, crypto.randomUUID()],
        );
        if (!accepted.changes) throw new Error("Epic reconciliation workspace changed");
      }).immediate();
    } catch (error) {
      return Promise.reject(error);
    }
    const key = JSON.stringify([target.workspaceId, target.epicId]);
    const existing = flights.get(key);
    if (existing) {
      existing.dirty = true;
      return waitForFlight(existing.promise, target.signal);
    }
    const flight = { dirty: false, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        do {
          flight.dirty = false;
          const request = db
            .query<{ token: string }, [string]>(
              "SELECT token FROM epic_reconciliation_request WHERE epic_id=?",
            )
            .get(target.epicId);
          if (!request) throw new Error("Epic reconciliation request changed");
          await refresh({ ...target, signal: shutdown.signal }, request.token);
        } while (flight.dirty);
      } finally {
        flights.delete(key);
      }
    })();
    flights.set(key, flight);
    return waitForFlight(flight.promise, target.signal);
  }

  function activeTargets(issue?: IssueChange): Target[] {
    return db
      .query<
        Target,
        [string | null, string | null, string | null, string | null, string | null, string | null]
      >(
        `SELECT DISTINCT e.id AS epicId,w.id AS workspaceId FROM epic e
         JOIN work_item linked ON linked.epic_id=e.id AND linked.session_key IS NOT NULL
         JOIN linear_session s ON s.session_id=linked.session_key
         JOIN workspace w ON w.linear_organization_id=s.organization_id
         WHERE e.state IN ('running','stalled') AND s.stopped_at IS NULL
         AND (? IS NULL OR s.organization_id=?)
         AND (? IS NULL OR e.linear_issue_id=?
          OR EXISTS(SELECT 1 FROM work_item i WHERE i.epic_id=e.id AND i.linear_issue_id=?5)
          OR EXISTS(SELECT 1 FROM task_block b WHERE b.blocker_linear_issue_id=?5 AND e.id=(
            SELECT i.epic_id FROM work_item i
            WHERE i.linear_issue_id=b.blocked_linear_issue_id AND i.state<>'cancelled'
            AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
            ORDER BY i.created_at DESC, i.id DESC LIMIT 1))
          OR e.linear_issue_id=?6)`,
      )
      .all(
        issue?.organizationId ?? null,
        issue?.organizationId ?? null,
        issue?.issueId ?? null,
        issue?.issueId ?? null,
        issue?.issueId ?? null,
        issue?.parentIssueId ?? null,
      );
  }

  async function issueChanged(issue: IssueChange) {
    shutdown.signal.throwIfAborted();
    if (!issue.issueId || !issue.organizationId)
      throw new Error("Missing Linear issue event identity");
    const targets = activeTargets(issue);
    await Promise.all(targets.map(reconcile));
    return targets;
  }

  function sweep(options: { now?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason);
    if (sweepFlight) return sweepFlight;
    const time = options.now ?? now();
    if (lastSweep !== null && time >= lastSweep && time - lastSweep < 300_000)
      return Promise.resolve();
    sweepFlight = (async () => {
      try {
        await Promise.all(
          activeTargets().map((target) => reconcile({ ...target, signal: options.signal })),
        );
        lastSweep = time;
      } finally {
        sweepFlight = null;
      }
    })();
    return sweepFlight;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    shutdown.abort(new DOMException("Epic reconciliation stopped", "AbortError"));
    closing = Promise.allSettled([...flights.values()].map((flight) => flight.promise)).then(
      () => undefined,
    );
    return closing;
  }

  return { reconcile, issueChanged, sweep, close };
}
