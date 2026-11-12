import type { Database } from "bun:sqlite";
import { isBlockerSatisfied, type WorkItemState } from "../src/core";
import {
  bindLinearSessionTaskSteps,
  getTaskModeSteps,
  getConfirmedRemoteMergeSteps,
  recordConfirmedRemoteMerge,
  recordLinearInstallationSteps,
  sqliteDb,
  storeOf,
  type Db,
  type Q,
  type Steps,
} from "../src/db";
import { and, asc, desc, eq, inArray, isNotNull, notExists, notInArray, sql } from "drizzle-orm";
import { itemDependenciesCurrentSteps, recordItemDependenciesSteps } from "../src/intake";
import { createAdmission, dispatch, type ItemAdmission } from "../src/scheduler";

type AdmissionOptions = Omit<Parameters<typeof createAdmission>[0], "db">;
type Session = {
  sessionId: string;
  organizationId: string | null;
  clientId: string | null;
  appUserId: string | null;
  teamId: string | null;
};

const DEPENDENCY_INPUTS = `SELECT json_array(
  (SELECT json_group_array(json_array(i.id,i.linear_issue_id,i.linear_identifier,i.title,i.state,
    i.version,i.position,i.created_at,i.cancel_requested,i.session_key,i.brief,i.owner_user_id,
    i.delegated_by,u.linear_user_id,t.mode,p.present))
   FROM work_item i LEFT JOIN work_item_task t ON t.item_id=i.id
   LEFT JOIN work_item_specification p ON p.item_id=i.id
   LEFT JOIN workspace_user u ON u.id=i.owner_user_id WHERE i.delegation_id=d.delegation_id),
  (SELECT json_group_array(json_array(s.session_id,s.organization_id,s.oauth_client_id,
    s.app_user_id,s.team_id,s.creator_id,s.generation,s.stopped_at,w.id))
   FROM linear_session s LEFT JOIN workspace w ON w.linear_organization_id=s.organization_id
   WHERE s.session_id IN (SELECT session_key FROM work_item WHERE delegation_id=d.delegation_id)),
  (SELECT json_group_array(json_array(pd.parent_issue_id,pd.stopped_at,sub.issue_id))
   FROM parent_delegation_issue sub JOIN parent_delegation pd ON pd.delegation_id=sub.parent_delegation_id
   WHERE sub.delegation_id=d.delegation_id),
  (SELECT json_array(workspace_id,generation,scope,linear_states)
   FROM item_dependency_snapshot WHERE item_id=d.id)) AS inputs
  FROM work_item d WHERE d.id=?`;
const currentInputs = new WeakMap<Database, Map<string, string>>();

export function workspaceAdmission(
  source: Database | Db,
  options: AdmissionOptions = {},
): ItemAdmission {
  const store = storeOf(source);
  const raw = "dialect" in source ? null : source;
  const admission = createAdmission({ db: store, ...options });
  const joined =
    <R>(check: (id: string) => Promise<R>, byItem: boolean) =>
    async (id: string): Promise<R> => {
      await store.run((q) => joinFakeWorkspaceSteps(q, raw, id, byItem));
      return check(id);
    };
  const joinedSteps = <R>(check: (q: Q, id: string) => Steps<R>, byItem: boolean) =>
    function* (q: Q, id: string): Steps<R> {
      yield* joinFakeWorkspaceSteps(q, raw, id, byItem);
      return yield* check(q, id);
    };
  return {
    canDispatchDelegation: joined(admission.canDispatchDelegation, false),
    canStart: joined(admission.canStart, true),
    canMerge: joined(admission.canMerge, true),
    steps: {
      canDispatchDelegation: joinedSteps(admission.steps.canDispatchDelegation, false),
      canStart: joinedSteps(admission.steps.canStart, true),
      canMerge: joinedSteps(admission.steps.canMerge, true),
    },
  };
}

export function workspaceDispatch(
  db: Database,
  options: Omit<Parameters<typeof dispatch>[1], "admission">,
): Promise<string[]> {
  return dispatch(sqliteDb(db), { ...options, admission: workspaceAdmission(db) });
}

export function joinFakeWorkspace(db: Database, delegationId: string): Promise<void> {
  return sqliteDb(db).run((q) => joinFakeWorkspaceSteps(q, db, delegationId, false));
}

export function workspaceDispatchPg(
  db: Db,
  options: Omit<Parameters<typeof dispatch>[1], "admission">,
): Promise<string[]> {
  return dispatch(db, { ...options, admission: workspaceAdmission(db) });
}

export function joinFakeWorkspacePg(db: Db, delegationId: string): Promise<void> {
  return db.run((q) => joinFakeWorkspaceSteps(q, null, delegationId, false));
}

const open = (q: Q) => notInArray(q.t.workItem.state, ["completed", "merged", "cancelled"]);

const present = (q: Q) =>
  notExists(
    q.orm
      .select({ one: sql`1` })
      .from(q.t.workItemSpecification)
      .where(
        and(
          eq(q.t.workItemSpecification.itemId, q.t.workItem.id),
          eq(q.t.workItemSpecification.present, 0),
        ),
      ),
  );

function* joinFakeWorkspaceSteps(
  q: Q,
  raw: Database | null,
  id: string,
  byItem: boolean,
): Steps<void> {
  const item = q.t.workItem;
  const delegationId = byItem
    ? (yield* q.one(q.orm.select({ id: item.delegationId }).from(item).where(eq(item.id, id))))?.id
    : id;
  if (delegationId === undefined) return;
  const fallback =
    (yield* q.one(
      q.orm
        .select({ org: q.t.workspace.linearOrganizationId })
        .from(q.t.workspace)
        .orderBy(asc(q.t.workspace.createdAt), asc(q.t.workspace.id))
        .limit(1),
    ))?.org ?? "org";
  const items = yield* q.all(
    q.orm
      .select({ id: item.id, sessionId: item.sessionKey })
      .from(item)
      .where(and(eq(item.delegationId, delegationId), open(q), present(q))),
  );
  if (items.length === 0) return;
  if (items.every((row) => row.sessionId === null)) {
    const sessionId = `session-${delegationId}`;
    yield* installSteps(q, { sessionId, organizationId: fallback });
    yield* bindLinearSessionTaskSteps(q, sessionId, delegationId);
  }
  const session = q.t.linearSession;
  const sessions: Session[] = yield* q.all(
    q.orm
      .selectDistinct({
        sessionId: sql<string>`${item.sessionKey}`,
        organizationId: session.organizationId,
        clientId: session.oauthClientId,
        appUserId: session.appUserId,
        teamId: session.teamId,
      })
      .from(item)
      .leftJoin(session, eq(session.sessionId, item.sessionKey))
      .where(and(eq(item.delegationId, delegationId), isNotNull(item.sessionKey), open(q))),
  );
  for (const row of sessions) {
    const organizationId = row.organizationId ?? fallback;
    yield* ensureWorkspaceSteps(q, organizationId);
    if (row.organizationId && row.clientId && row.appUserId && row.teamId) continue;
    yield* installSteps(q, { ...row, organizationId });
  }
  for (const { id: itemId } of items) {
    const workspaceId = (yield* q.one(
      q.orm
        .select({ id: q.t.workspace.id })
        .from(item)
        .innerJoin(session, eq(session.sessionId, item.sessionKey))
        .innerJoin(q.t.workspace, eq(q.t.workspace.linearOrganizationId, session.organizationId))
        .where(eq(item.id, itemId)),
    ))?.id;
    if (workspaceId === undefined) continue;
    const target = { itemId, workspaceId };
    const fresh = yield* readsSteps(q, itemId);
    const snapshot = q.t.itemDependencySnapshot;
    const saved = yield* q.one(
      q.orm
        .select({ generation: snapshot.generation, linearStates: snapshot.linearStates })
        .from(snapshot)
        .where(eq(snapshot.itemId, itemId)),
    );
    const savedStates =
      typeof saved?.linearStates === "string"
        ? saved.linearStates
        : JSON.stringify(saved?.linearStates);
    const inputs = raw
      ?.query<{ inputs: string }, [string]>(DEPENDENCY_INPUTS)
      .get(itemId)
      ?.inputs.concat(workspaceId);
    const cache = raw ? (currentInputs.get(raw) ?? new Map<string, string>()) : null;
    if (raw && cache) currentInputs.set(raw, cache);
    if (
      saved !== undefined &&
      savedStates === JSON.stringify([...fresh.states]) &&
      ((inputs !== undefined && cache?.get(itemId) === inputs) ||
        (yield* itemDependenciesCurrentSteps(q, target)))
    ) {
      if (inputs !== undefined) cache?.set(itemId, inputs);
      continue;
    }
    try {
      yield* recordItemDependenciesSteps(
        q,
        { ...target, expectedGeneration: saved?.generation ?? 0 },
        fresh,
      );
    } catch {
      continue;
    }
  }
}

function* installSteps(
  q: Q,
  session: Partial<Session> & { sessionId: string; organizationId: string },
): Steps<void> {
  yield* ensureWorkspaceSteps(q, session.organizationId);
  yield* recordLinearInstallationSteps(q, {
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    oauthClientId: session.clientId ?? "client",
    appUserId: session.appUserId ?? "app",
    teamId: session.teamId ?? "team",
    observedAtMs: 0,
  });
}

function* ensureWorkspaceSteps(q: Q, organizationId: string): Steps<void> {
  yield* q.exec(
    q.orm
      .insert(q.t.workspace)
      .values({
        id: organizationId === "org" ? "workspace" : `workspace-${organizationId}`,
        linearOrganizationId: organizationId,
        name: "Workspace",
        createdAt: 0,
      })
      .onConflictDoNothing({ target: q.t.workspace.linearOrganizationId }),
  );
}

function* readsSteps(q: Q, itemId: string) {
  const item = q.t.workItem;
  const block = q.t.taskBlock;
  const edges = yield* q.all(
    q.orm
      .select({
        blockerLinearIssueId: block.blockerLinearIssueId,
        blockedLinearIssueId: block.blockedLinearIssueId,
      })
      .from(block)
      .innerJoin(item, eq(item.linearIssueId, block.blockedLinearIssueId))
      .where(eq(item.id, itemId)),
  );
  const delegationId = q.orm
    .select({ id: item.delegationId })
    .from(item)
    .where(eq(item.id, itemId));
  const states = new Map<string, "completed" | "started">();
  for (const { blockerLinearIssueId: id } of edges) {
    const blocker = yield* q.one(
      q.orm
        .select({ id: item.id, state: sql<WorkItemState>`${item.state}` })
        .from(item)
        .where(
          and(eq(item.linearIssueId, id), present(q), inArray(item.delegationId, delegationId)),
        )
        .orderBy(desc(item.position), desc(item.createdAt), desc(item.id))
        .limit(1),
    );
    const satisfied =
      !blocker ||
      isBlockerSatisfied({
        ...blocker,
        mode: yield* getTaskModeSteps(q, blocker.id),
        mergeSha: (yield* getConfirmedRemoteMergeSteps(q, blocker.id))?.mergeSha ?? null,
      });
    states.set(id, satisfied ? "completed" : "started");
  }
  return { edges, states, identifiers: new Map<string, string>(), evidence: {} };
}

/** Record the evidence a real merge writes before a fixture enters merged. */
export function confirmFakeMerge(db: Database, itemId: string): Promise<void> {
  return confirmFakeMergePg(sqliteDb(db), itemId);
}

export async function confirmFakeMergePg(db: Db, itemId: string): Promise<void> {
  await recordConfirmedRemoteMerge(db, {
    itemId,
    repositoryOwner: "owner",
    repositoryName: "repo",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: `merge-${itemId}`,
    confirmedAt: 1000,
  });
}
