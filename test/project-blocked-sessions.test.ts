import { expect, test } from "bun:test";
import { MEMBERSHIP_BACKSTOP_MS, ensureLinearSession } from "../src/db";
import type { EpicSnapshot } from "../src/linear";
import { createProjectFixture } from "./local/project-fixture";

type Fixture = ReturnType<typeof createProjectFixture>;

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
  f.projects.register(f.jobs);
}

async function pass(f: Fixture) {
  f.clock.advance(30_000);
  await f.jobs.tick();
}

function merge(f: Fixture, issueId: string) {
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

function waiting(f: Fixture) {
  const approval = f.projects.list("workspace")[0]!;
  return Object.fromEntries(
    f.projects.progress(approval.id).map((claim) => [claim.issueId, claim.waitingFor]),
  );
}

test("a chain of sub-issues opens each Linear session only after its blocker merges", async () => {
  const f = createProjectFixture();
  try {
    f.tracker.deps.set("b", [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }]);
    f.tracker.deps.set("c", [{ blockerLinearIssueId: "b", blockedLinearIssueId: "c" }]);
    await delegate(f, [child("a", "CH-1"), child("b", "CH-2"), child("c", "CH-3")]);
    await f.jobs.tick();
    expect(f.started).toEqual(["a"]);
    expect(waiting(f)).toEqual({ a: [], b: ["CH-1"], c: ["CH-2"] });

    await pass(f);
    expect(f.started).toEqual(["a"]);

    merge(f, "a");
    await pass(f);
    expect(f.started).toEqual(["a", "b"]);
    expect(waiting(f)).toEqual({ a: [], b: [], c: ["CH-2"] });

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
  const f = createProjectFixture();
  try {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    deliverIssue(f, "outside", "OUT-1", "started");
    await delegate(f, [child("a", "CH-1")]);
    await f.jobs.tick();
    expect(f.started).toEqual([]);
    expect(waiting(f)).toEqual({ a: ["OUT-1"] });

    f.clock.advance(1);
    deliverIssue(f, "outside", "OUT-1", "completed");
    await pass(f);
    expect(f.started).toEqual(["a"]);
  } finally {
    await f.close();
  }
});

test("the recurring job makes no Linear call for a claim that is still blocked", async () => {
  const f = createProjectFixture();
  try {
    f.tracker.deps.set("a", [{ blockerLinearIssueId: "outside", blockedLinearIssueId: "a" }]);
    deliverIssue(f, "outside", "OUT-1", "started");
    await delegate(f, [child("a", "CH-1")]);
    const before = f.memberReads;
    // Past the membership backstop, an unblocked project would read Linear again.
    f.clock.advance(MEMBERSHIP_BACKSTOP_MS);
    for (let i = 0; i < 3; i++) await pass(f);
    expect(f.started).toEqual([]);
    expect(f.memberReads).toBe(before);
    const approval = f.projects.list("workspace")[0]!;
    expect(approval.lastError).toBeNull();
    // With every sub-issue blocked, the parent still gets its one summary.
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
