import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  advanceLinearSessionGeneration,
  bindLinearSessionTask,
  changeLinearTeamAccess,
  getLinearTaskDelegation,
  getWorkItem,
  migrate,
  openDatabase,
  recordLinearInstallation,
  revokeLinearInstallation,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import {
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  createLinearIssueLifecycle,
  parseAgentEvent,
} from "../src/linear";
import { LinearTaskAccess } from "../src/loop";
import { tempHome } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
async function fixture(child = false, actorId: string | null = "human") {
  const path = join(tempHome(), "paws.db");
  const db = openDatabase(path);
  databases.push(db);
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Request",
      description: null,
      subIssues: child
        ? [{ linearIssueId: "child", identifier: "ENG-2", title: "Child", description: null }]
        : [],
    },
  ]);
  const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent" });
  if (!task.ok) throw new Error("Unexpected cycle");
  recordLinearInstallation(db, {
    ...scope,
    sessionId: "session",
    teamId: "parent-team",
    observedAtMs: 1,
  });
  bindLinearSessionTask(db, "session", task.epic.id, { actorId });
  const access = createFakeLinearAccessReads({
    installation: scope,
    sessions: [{ ...scope, sessionId: "session", issueId: "parent", teamId: "parent-team" }],
    teams: ["parent-team", "child-team"],
  });
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "parent",
    teamId: "parent-team",
    assigneeId: "human-assignee",
    delegateId: null,
    stateType: "unstarted",
  });
  lifecycle.issues.set("child", {
    id: "child",
    teamId: "child-team",
    assigneeId: "other-human",
    delegateId: null,
    stateType: "unstarted",
  });
  const stopped: string[] = [];
  const gate = new LinearTaskAccess(db, {
    access: access.adapter,
    lifecycle,
    oauthClientId: "client",
    appUserId: null,
    stopSession: (id) => {
      stopped.push(id);
    },
    now: () => 10,
  });
  const item = getWorkItem(db, task.items[0]!.id)!;
  return { db, path, task, item, access, lifecycle, stopped, gate };
}

test("code preparation starts canonical parent and child while preserving human assignees", async () => {
  const f = await fixture(true);
  expect(await f.gate.prepare(f.item, new AbortController().signal)).toEqual(["child", "parent"]);
  expect(f.lifecycle.started.map((input) => input.issueId)).toEqual(["child", "parent"]);
  expect(f.lifecycle.issue.assigneeId).toBe("human-assignee");
  expect(f.lifecycle.issues.get("child")?.assigneeId).toBe("other-human");
  for (const issueId of ["child", "parent"])
    expect(getLinearTaskDelegation(f.db, f.item.id, issueId)).toMatchObject({
      appUserId: "app",
      humanActorId: "human",
    });
});

test("noncode may read a completed issue while code preparation remains fenced", async () => {
  const f = await fixture();
  f.lifecycle.issue.stateType = "completed";
  await f.gate.assert(f.item, new AbortController().signal, { allowTerminalIssue: true });
  expect(f.lifecycle.started).toEqual([]);
  expect(f.stopped).toEqual([]);
  await expect(f.gate.prepare(f.item, new AbortController().signal)).rejects.toThrow("workflow");
  expect(f.lifecycle.started).toEqual([]);
  expect(f.stopped).toEqual(["session"]);
});

test("noncode on a completed issue still rejects removed team and delegation access", async () => {
  const f = await fixture();
  f.lifecycle.issue.stateType = "completed";
  f.lifecycle.issue.delegateId = "another-app";
  await expect(
    f.gate.assert(f.item, new AbortController().signal, { allowTerminalIssue: true }),
  ).rejects.toThrow("delegation");
  expect(f.lifecycle.started).toEqual([]);
  expect(f.stopped).toEqual(["session"]);
});

test("automation without a delegate does not change status or claim delegation", async () => {
  const f = await fixture(false, null);
  expect(await f.gate.prepare(f.item, new AbortController().signal)).toEqual([]);
  expect(f.lifecycle.issue.stateType).toBe("unstarted");
  expect(f.lifecycle.issue.delegateId).toBeNull();
  expect(getLinearTaskDelegation(f.db, f.item.id, "parent")).toBeNull();
});

test("human reassignment keeps a delegated code task running but removal stops every child via its session", async () => {
  const f = await fixture(true);
  await f.gate.prepare(f.item, new AbortController().signal);
  f.lifecycle.issue.assigneeId = "another-human";
  await f.gate.assert(f.item, new AbortController().signal);
  expect(f.stopped).toEqual([]);
  f.lifecycle.issue.delegateId = null;
  await expect(f.gate.prepare(f.item, new AbortController().signal)).rejects.toThrow("removed");
  expect(f.stopped).toEqual(["session"]);
  expect(f.lifecycle.started).toHaveLength(2);
});

test.each(["unknown", "rejected"])(
  "an uncertain %s delegation attempt persists before mutation and cannot reclaim after restart",
  async (outcome) => {
    const f = await fixture();
    let mutations = 0;
    const issue = {
      id: "parent",
      team: { id: "parent-team" },
      state: { type: "started" },
      assignee: { id: "human-assignee" },
      delegate: null as { id: string } | null,
    };
    const lifecycle = createLinearIssueLifecycle({
      async query(query) {
        if (query.includes("IssueOwnership")) return { issue: structuredClone(issue) };
        if (query.includes("CodeTaskActor")) return { user: { id: "human", app: false } };
        if (query.includes("StartDelegatedIssue")) {
          mutations++;
          expect(getLinearTaskDelegation(f.db, f.item.id, "parent")).toMatchObject({
            humanActorId: "human",
            teamId: "parent-team",
          });
          if (outcome === "unknown") {
            issue.delegate = { id: "app" };
            throw new Error("Connection lost after acceptance");
          }
          return { issueUpdate: { success: false } };
        }
        throw new Error("Unexpected query");
      },
    });
    const gate = new LinearTaskAccess(f.db, {
      access: f.access.adapter,
      lifecycle,
      oauthClientId: "client",
      appUserId: "app",
      stopSession: () => {},
      now: () => 10,
    });
    await expect(gate.prepare(f.item, new AbortController().signal)).rejects.toThrow();
    issue.delegate = null;
    const reopened = openDatabase(f.path);
    databases.push(reopened);
    const recovered = new LinearTaskAccess(reopened, {
      access: f.access.adapter,
      lifecycle,
      oauthClientId: "client",
      appUserId: "app",
      stopSession: () => {},
      now: () => 11,
    });
    await expect(recovered.prepare(f.item, new AbortController().signal)).rejects.toThrow(
      "removed",
    );
    expect(mutations).toBe(1);
    expect(getLinearTaskDelegation(reopened, f.item.id, "parent")?.humanActorId).toBe("human");
  },
);

test("child-team removal is checked durably even while authoritative reads still return accessible", async () => {
  const f = await fixture(true);
  await f.gate.prepare(f.item, new AbortController().signal);
  changeLinearTeamAccess(f.db, {
    ...scope,
    eventKey: "remove-child",
    createdAtMs: 20,
    canAccessAllPublicTeams: true,
    addedTeamIds: [],
    removedTeamIds: ["child-team"],
  });
  await expect(f.gate.assert(f.item, new AbortController().signal)).rejects.toThrow("removed");
  expect(f.stopped).toEqual(["session"]);
});

test("a public-team permission drop triggers fresh team access rather than assuming all teams were removed", async () => {
  const f = await fixture(true);
  await f.gate.prepare(f.item, new AbortController().signal);
  changeLinearTeamAccess(f.db, {
    ...scope,
    eventKey: "public-drop",
    createdAtMs: 20,
    canAccessAllPublicTeams: false,
    addedTeamIds: [],
    removedTeamIds: [],
  });
  await f.gate.assert(f.item, new AbortController().signal);
  f.access.state.teams.delete("child-team");
  await expect(f.gate.assert(f.item, new AbortController().signal)).rejects.toThrow("team access");
});

test.each(["generation", "revocation"])(
  "%s changing during a session read prevents code preparation",
  async (change) => {
    const f = await fixture();
    const original = f.access.adapter.session;
    f.access.adapter.session = async (...args) => {
      const result = await original(...args);
      if (change === "generation") advanceLinearSessionGeneration(f.db, "session");
      else revokeLinearInstallation(f.db, { ...scope, eventKey: "revoke", createdAtMs: 20 });
      return result;
    };
    await expect(f.gate.prepare(f.item, new AbortController().signal)).rejects.toThrow();
    expect(f.lifecycle.started).toEqual([]);
  },
);

test("verified ingress hydrates missing configured app user and rejects a mismatched canonical issue", async () => {
  const f = await fixture();
  const event = parseAgentEvent(
    JSON.stringify({
      ...scope,
      type: "AgentSessionEvent",
      action: "created",
      agentSession: { id: "session", issue: { id: "parent", team: { id: "parent-team" } } },
    }),
    "delivery",
    2,
  )!;
  expect(await f.gate.accept(event)).toBe(true);
  await expect(f.gate.accept({ ...event, issueId: "other" })).resolves.toBe(false);
  expect(f.lifecycle.started).toEqual([]);
});

test("notification reconciliation performs no workflow mutation and stops a removed delegation", async () => {
  const f = await fixture(true);
  await f.gate.prepare(f.item, new AbortController().signal);
  f.lifecycle.issue.assigneeId = "another-human";
  await f.gate.reconcile("parent");
  expect(f.stopped).toEqual([]);
  f.lifecycle.issue.delegateId = null;
  await f.gate.reconcile("parent");
  expect(f.stopped).toEqual(["session"]);
  expect(f.lifecycle.started).toHaveLength(2);
});

test("transient notification reads remain retryable and unrelated issues do not trigger access reads", async () => {
  const f = await fixture();
  await f.gate.reconcile("unrelated");
  expect(f.access.calls).toEqual([]);
  f.access.adapter.session = async () => {
    throw new Error("Temporary offline read");
  };
  await expect(f.gate.reconcile("parent")).rejects.toThrow("Temporary offline");
  expect(f.stopped).toEqual([]);
});
