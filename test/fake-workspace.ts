import type { Database } from "bun:sqlite";
import { isBlockerSatisfied, type WorkItemState } from "../src/core";
import {
  bindLinearSessionTask,
  getTaskMode,
  getConfirmedRemoteMerge,
  recordConfirmedRemoteMerge,
  recordLinearInstallation,
} from "../src/db";
import { itemDependenciesCurrent, recordItemDependencies } from "../src/intake";
import { createAdmission, dispatch, type ItemAdmission } from "../src/scheduler";

type AdmissionOptions = Omit<Parameters<typeof createAdmission>[0], "db">;
type Session = {
  sessionId: string;
  organizationId: string | null;
  clientId: string | null;
  appUserId: string | null;
  teamId: string | null;
};

const OPEN = "i.state NOT IN ('completed','merged','cancelled')";
const PRESENT =
  "NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)";

export function workspaceAdmission(db: Database, options: AdmissionOptions = {}): ItemAdmission {
  const admission = createAdmission({ db, ...options });
  const ofItem = (itemId: string) =>
    db
      .query<{ id: string }, [string]>("SELECT delegation_id AS id FROM work_item WHERE id=?")
      .get(itemId)?.id;
  const joined =
    (delegationOf: (id: string) => string | undefined) =>
    <R>(check: (id: string) => R) =>
    (id: string): R => {
      const delegationId = delegationOf(id);
      if (delegationId !== undefined) joinFakeWorkspace(db, delegationId);
      return check(id);
    };
  return {
    canDispatchDelegation: joined((id) => id)(admission.canDispatchDelegation),
    canStart: joined(ofItem)(admission.canStart),
    canMerge: joined(ofItem)(admission.canMerge),
  };
}

export function workspaceDispatch(
  db: Database,
  options: Omit<Parameters<typeof dispatch>[1], "admission">,
): string[] {
  return dispatch(db, { ...options, admission: workspaceAdmission(db) });
}

export function joinFakeWorkspace(db: Database, delegationId: string): void {
  const fallback =
    db
      .query<{ org: string }, []>(
        "SELECT linear_organization_id AS org FROM workspace ORDER BY created_at,id LIMIT 1",
      )
      .get()?.org ?? "org";
  const items = db
    .query<{ id: string; sessionId: string | null }, [string]>(
      `SELECT i.id,i.session_key AS sessionId FROM work_item i
       WHERE i.delegation_id=? AND ${OPEN} AND ${PRESENT}`,
    )
    .all(delegationId);
  if (items.length === 0) return;
  if (items.every((item) => item.sessionId === null)) {
    const sessionId = `session-${delegationId}`;
    install(db, { sessionId, organizationId: fallback });
    bindLinearSessionTask(db, sessionId, delegationId);
  }
  const sessions = db
    .query<Session, [string]>(
      `SELECT DISTINCT i.session_key AS sessionId,s.organization_id AS organizationId,
       s.oauth_client_id AS clientId,s.app_user_id AS appUserId,s.team_id AS teamId
       FROM work_item i LEFT JOIN linear_session s ON s.session_id=i.session_key
       WHERE i.delegation_id=? AND i.session_key IS NOT NULL AND ${OPEN}`,
    )
    .all(delegationId);
  for (const session of sessions) {
    const organizationId = session.organizationId ?? fallback;
    ensureWorkspace(db, organizationId);
    if (session.organizationId && session.clientId && session.appUserId && session.teamId) continue;
    install(db, { ...session, organizationId });
  }
  for (const item of items) {
    const workspaceId = db
      .query<{ id: string }, [string]>(
        `SELECT w.id FROM work_item i JOIN linear_session s ON s.session_id=i.session_key
         JOIN workspace w ON w.linear_organization_id=s.organization_id WHERE i.id=?`,
      )
      .get(item.id)?.id;
    if (workspaceId === undefined) continue;
    const target = { itemId: item.id, workspaceId };
    const fresh = reads(db, item.id);
    const saved = snapshot(db, item.id);
    if (
      itemDependenciesCurrent(db, target) &&
      saved?.linearStates === JSON.stringify([...fresh.states])
    )
      continue;
    try {
      recordItemDependencies(db, { ...target, expectedGeneration: saved?.generation ?? 0 }, fresh);
    } catch {
      continue;
    }
  }
}

function install(
  db: Database,
  session: Partial<Session> & { sessionId: string; organizationId: string },
) {
  ensureWorkspace(db, session.organizationId);
  recordLinearInstallation(db, {
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    oauthClientId: session.clientId ?? "client",
    appUserId: session.appUserId ?? "app",
    teamId: session.teamId ?? "team",
    observedAtMs: 0,
  });
}

function ensureWorkspace(db: Database, organizationId: string) {
  db.run(
    `INSERT INTO workspace(id,linear_organization_id,name,created_at) SELECT ?,?,'Workspace',0
     WHERE NOT EXISTS(SELECT 1 FROM workspace WHERE linear_organization_id=?)`,
    [
      organizationId === "org" ? "workspace" : `workspace-${organizationId}`,
      organizationId,
      organizationId,
    ],
  );
}

function snapshot(db: Database, itemId: string) {
  return db
    .query<{ generation: number; linearStates: string }, [string]>(
      "SELECT generation,linear_states AS linearStates FROM item_dependency_snapshot WHERE item_id=?",
    )
    .get(itemId);
}

function reads(db: Database, itemId: string) {
  const edges = db
    .query<{ blockerLinearIssueId: string; blockedLinearIssueId: string }, [string]>(
      `SELECT b.blocker_linear_issue_id AS blockerLinearIssueId,b.blocked_linear_issue_id AS blockedLinearIssueId
       FROM task_block b JOIN work_item i ON i.linear_issue_id=b.blocked_linear_issue_id WHERE i.id=?`,
    )
    .all(itemId);
  const states = new Map(
    edges.map(({ blockerLinearIssueId: id }) => {
      const blocker = db
        .query<{ id: string; state: WorkItemState }, [string, string]>(
          `SELECT i.id,i.state FROM work_item i
           WHERE i.linear_issue_id=? AND ${PRESENT}
           AND i.delegation_id=(SELECT delegation_id FROM work_item WHERE id=?)
           ORDER BY i.position DESC,i.rowid DESC LIMIT 1`,
        )
        .get(id, itemId);
      const satisfied =
        !blocker ||
        isBlockerSatisfied({
          ...blocker,
          mode: getTaskMode(db, blocker.id),
          mergeSha: getConfirmedRemoteMerge(db, blocker.id)?.mergeSha ?? null,
        });
      return [id, satisfied ? "completed" : "started"] as const;
    }),
  );
  return { edges, states, identifiers: new Map<string, string>(), evidence: {} };
}

/** Record the evidence a real merge writes before a fixture enters merged. */
export function confirmFakeMerge(db: Database, itemId: string): void {
  recordConfirmedRemoteMerge(db, {
    itemId,
    repositoryOwner: "owner",
    repositoryName: "repo",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: `merge-${itemId}`,
    confirmedAt: 1000,
  });
}
