import { confirmFakeMerge } from "./fake-workspace";
import { expect, test } from "bun:test";
import { ensureLinearSession } from "../src/db";
import type { EpicSnapshot } from "../src/linear";
import { createParentFixture } from "./local/parent-fixture";

type Fixture = ReturnType<typeof createParentFixture>;

function child(linearIssueId: string, identifier: string) {
  return {
    linearIssueId,
    identifier,
    title: identifier,
    description: `Implement ${identifier}`,
    teamId: "team",
  };
}

async function delegate(f: Fixture, subIssues: EpicSnapshot["subIssues"]) {
  const parent: EpicSnapshot = {
    linearIssueId: "parent",
    identifier: "PAR-1",
    title: "Parent",
    description: "Parent body",
    teamId: "team",
    subIssues,
  };
  f.tracker.epics.set(parent.linearIssueId, parent);
  for (const issue of subIssues)
    f.tracker.epics.set(issue.linearIssueId, {
      ...issue,
      description: issue.description ?? null,
      subIssues: [],
    });
  ensureLinearSession(f.db, {
    sessionId: "parent-session",
    issueId: "parent",
    organizationId: "org",
    creatorId: "lead",
    now: f.clock.now(),
  });
  const admitted = await f.orchestrator.intakeLinearTask("parent", "parent-session", "parent-task");
  expect(admitted.ok).toBe(true);
  f.parents.register(f.jobs);
  return admitted.delegation.id;
}

async function pass(f: Fixture) {
  f.clock.advance(30_000);
  await f.jobs.tick();
}

function merge(f: Fixture, issueId: string) {
  const item = f.db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_issue_id=?")
    .get(issueId)!;
  confirmFakeMerge(f.db, item.id);
  f.db.run("UPDATE work_item SET state='merged' WHERE linear_issue_id=?", [issueId]);
}

function deliverIssue(f: Fixture, issueId: string, identifier: string, stateType: string) {
  const at = f.clock.now();
  f.db.run(
    `INSERT INTO inbox_event(dedupe_key,source,action,updated_at_ms,payload,received_at,handled)
     VALUES(?,'webhook','other',?,?,?,1)`,
    [
      `issue:${issueId}:${at}`,
      at,
      JSON.stringify({
        type: "Issue",
        action: "update",
        organizationId: "org",
        data: { id: issueId, identifier, state: { type: stateType } },
      }),
      at,
    ],
  );
}

function waiting(f: Fixture, parent: string) {
  return Object.fromEntries(f.parents.progress(parent).map((sub) => [sub.issueId, sub.waitingFor]));
}

test("a chain of sub-issues opens each Linear session only after its blocker merges", async () => {
  const f = createParentFixture();
  try {
    f.tracker.deps.set("b", [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }]);
    f.tracker.deps.set("c", [{ blockerLinearIssueId: "b", blockedLinearIssueId: "c" }]);
    const parent = await delegate(f, [child("a", "CH-1"), child("b", "CH-2"), child("c", "CH-3")]);
    await f.jobs.tick();
    expect(f.started).toEqual(["a"]);
    expect(waiting(f, parent)).toEqual({ a: [], b: ["CH-1"], c: ["CH-2"] });

    await pass(f);
    expect(f.started).toEqual(["a"]);

    merge(f, "a");
    await pass(f);
    expect(f.started).toEqual(["a", "b"]);
    expect(waiting(f, parent)).toEqual({ a: [], b: [], c: ["CH-2"] });

    await pass(f);
    expect(f.started).toEqual(["a", "b"]);

    merge(f, "b");
    await pass(f);
    expect(f.started).toEqual(["a", "b", "c"]);
  } finally {
    await f.close();
  }
});

test("a sub-issue blocked by an issue Paws does not manage opens once Linear says it is Done", async () => {
  const f = createParentFixture();
  try {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    deliverIssue(f, "outside", "OUT-1", "started");
    const parent = await delegate(f, [child("a", "CH-1")]);
    await f.jobs.tick();
    expect(f.started).toEqual([]);
    expect(waiting(f, parent)).toEqual({ a: ["OUT-1"] });

    f.clock.advance(1);
    deliverIssue(f, "outside", "OUT-1", "completed");
    await pass(f);
    expect(f.started).toEqual(["a"]);
  } finally {
    await f.close();
  }
});

test("the recurring job opens no session for a sub-issue that is still blocked", async () => {
  const f = createParentFixture();
  try {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    deliverIssue(f, "outside", "OUT-1", "started");
    await delegate(f, [child("a", "CH-1")]);
    for (let i = 0; i < 3; i++) await pass(f);
    expect(f.started).toEqual([]);
    expect(
      f.db
        .query<{ last_error: string | null }, []>("SELECT last_error FROM parent_delegation")
        .get()?.last_error,
    ).toBeNull();
    expect(
      f.db
        .query<{ body: string }, []>(
          "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE ordering_key='parent-session'",
        )
        .all()
        .map((row) => row.body),
    ).toEqual([
      [
        "Started the work in 1 sub-issue. It runs in its own session, so reply there to steer it.",
        "* CH-1 CH-1: waits for outside",
        "",
        "Stop this session to stop it.",
      ].join("\n"),
    ]);
  } finally {
    await f.close();
  }
});

test("the parent summary never says started for a sub-issue whose session is held", async () => {
  const f = createParentFixture();
  try {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    deliverIssue(f, "outside", "OUT-1", "canceled");
    f.issues.set("outside", {
      id: "outside",
      identifier: "OUT-1",
      teamId: "team",
      assigneeId: null,
      delegateId: null,
      stateType: "canceled",
    });
    await delegate(f, [child("a", "CH-1")]);
    await f.jobs.tick();
    expect(f.started).toEqual([]);
    expect(
      f.db
        .query<{ body: string }, []>(
          "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE ordering_key='parent-session'",
        )
        .all()
        .map((row) => row.body),
    ).toEqual([
      [
        "Started the work in 1 sub-issue. It runs in its own session, so reply there to steer it.",
        "* CH-1 CH-1: waits for OUT-1",
        "",
        "Stop this session to stop it.",
      ].join("\n"),
    ]);
  } finally {
    await f.close();
  }
});
