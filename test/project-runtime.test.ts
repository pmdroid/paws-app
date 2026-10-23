import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLinearSession,
  getWorkItem,
  delegatedLinearUserId,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { createProjectFixture } from "./local/project-fixture";
import {
  acknowledgeNewSession,
  LinearIntakePendingError,
  parseAgentEvent,
  type AcceptedLinearEvent,
} from "../src/linear";

test("approved project sessions use canonical single-issue intake, dependency holds and controls", async () => {
  const fixture = createProjectFixture();
  const { db, clock, projects, orchestrator, jobs, actor, selection, started, tracker } = fixture;
  try {
    const preview = await projects.preview(actor, selection, AbortSignal.timeout(10_000));
    await projects.approve(actor, preview.id, preview.generation, AbortSignal.timeout(10_000));
    projects.register(jobs);
    await jobs.tick();
    expect(started).toEqual(["one", "two"]);
    const progress = projects.progress(preview.id);
    const first = progress.find((claim) => claim.issueId === "one")!;
    const second = progress.find((claim) => claim.issueId === "two")!;
    expect(db.query("SELECT * FROM work_item").all()).toHaveLength(2);
    expect(delegatedLinearUserId(db, first.items[0]!.id)).toBe("actor");
    expect(projects.actor("session-one")).toBe("lead");
    expect(projects.canDispatch(second.epicId!)).toBe(false);
    expect(projects.canDispatch(first.epicId!)).toBe(true);
    clock.advance(30_000);
    await jobs.tick();
    expect(started).toHaveLength(2);
    ensureLinearSession(db, { sessionId: "duplicate", issueId: "one", organizationId: "org" });
    await expect(
      orchestrator.intakeLinearTask("one", "duplicate", "duplicate-task"),
    ).rejects.toThrow("assignment changed");
    expect(db.query("SELECT * FROM work_item").all()).toHaveLength(2);
    await projects.control(actor, preview.id, "pause");
    expect(projects.canDispatch(first.epicId!)).toBe(false);
    await projects.control(actor, preview.id, "resume");
    expect(projects.canDispatch(first.epicId!)).toBe(true);
    const changed = { ...(await tracker.loadEpic("one")), description: "Changed instructions" };
    expect(() => projects.scope("session-one", changed)).toThrow("requirements changed");
    await projects.control(actor, preview.id, "stop");
    expect(getWorkItem(db, first.items[0]!.id)?.state).toBe("cancelled");
    expect(projects.canDispatch(first.epicId!)).toBe(false);
    expect(
      db.query("SELECT * FROM project_approval_issue WHERE released_at IS NULL").all(),
    ).toHaveLength(0);
    const next = await projects.preview(actor, selection, AbortSignal.timeout(10_000));
    expect(next.id).not.toBe(preview.id);
  } finally {
    await fixture.close();
  }
});

test("a plain project member can answer or stop and an observer cannot", async () => {
  const f = createProjectFixture();
  try {
    for (const [id, role] of [
      ["plain", "member"],
      ["observer", "observer"],
    ] as const) {
      putWorkspaceUser(f.db, { id, linearUserId: id, name: id, email: `${id}@example.test` });
      syncWorkspaceMember(f.db, {
        workspaceId: "workspace",
        userId: id,
        role,
        active: true,
        teamIds: ["team"],
        now: f.clock.now(),
      });
    }
    const approval = await f.projects.preview(
      f.actor,
      {
        ...f.selection,
        steeringRoles: ["owner"],
      },
      AbortSignal.timeout(10_000),
    );
    await f.projects.approve(
      f.actor,
      approval.id,
      approval.generation,
      AbortSignal.timeout(10_000),
    );
    f.projects.register(f.jobs);
    await f.jobs.tick();
    const owners = f.db
      .query<{ owner_user_id: string }, []>("SELECT owner_user_id FROM work_item")
      .all();
    expect(owners).toHaveLength(2);
    expect(owners.every((row) => row.owner_user_id === "actor")).toBe(true);
    await f.orchestrator.intakeLinearTask("one", "session-one", "task-one");
    expect(
      f.db
        .query<{ owner_user_id: string }, []>("SELECT owner_user_id FROM work_item")
        .all()
        .every((row) => row.owner_user_id === "actor"),
    ).toBe(true);
    const prompted: AcceptedLinearEvent = {
      dedupeKey: "answer",
      deliveryId: null,
      source: "poll",
      action: "prompted",
      sessionId: "session-one",
      issueId: "one",
      activityId: "answer",
      actorId: "plain",
      body: "Ship it",
      signal: null,
      updatedAtMs: f.clock.now(),
      payload: "{}",
    };
    const stop: AcceptedLinearEvent = {
      ...prompted,
      dedupeKey: "stop",
      activityId: "stop",
      body: "Stop",
      signal: "stop",
    };
    expect(await f.projects.authorizeEvent(prompted)).toBe(true);
    expect(await f.projects.authorizeEvent({ ...prompted, actorId: "observer" })).toBe(false);
    await f.projects.control({ ...f.actor, userId: "lead" }, approval.id, "pause");
    expect(await f.projects.authorizeEvent(stop)).toBe(true);
    expect(await f.projects.authorizeEvent({ ...stop, actorId: "observer" })).toBe(false);
    await expect(
      f.projects.control({ workspaceId: "workspace", userId: "observer" }, approval.id, "stop"),
    ).rejects.toThrow("steering access");
    const itemId = f.projects.progress(approval.id).find((claim) => claim.issueId === "one")!
      .items[0]!.id;
    await f.projects.control({ workspaceId: "workspace", userId: "plain" }, approval.id, "stop");
    expect(getWorkItem(f.db, itemId)?.state).toBe("cancelled");
  } finally {
    await f.close();
  }
});

test("accepted sessions retry interrupted admission without creating new Linear sessions", async () => {
  const f = createProjectFixture();
  try {
    const approval = await f.projects.preview(f.actor, f.selection, AbortSignal.timeout(10_000));
    await f.projects.approve(
      f.actor,
      approval.id,
      approval.generation,
      AbortSignal.timeout(10_000),
    );
    f.intake.delayed = true;
    f.projects.register(f.jobs);
    await f.jobs.tick();
    expect(f.started).toEqual(["one", "two"]);
    expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(0);
    f.intake.delayed = false;
    f.clock.advance(30_000);
    await f.jobs.tick();
    expect(f.started).toEqual(["one", "two"]);
    expect(f.projects.progress(approval.id).every((claim) => claim.epicId !== null)).toBe(true);
    expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("a fresh process keeps approved claims paused without starting duplicate sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paws-project-restart-"));
  const filename = join(directory, "paws.sqlite");
  const fixture = createProjectFixture(filename);
  let closed = false;
  try {
    const approval = await fixture.projects.preview(
      fixture.actor,
      fixture.selection,
      AbortSignal.timeout(10_000),
    );
    await fixture.projects.approve(
      fixture.actor,
      approval.id,
      approval.generation,
      AbortSignal.timeout(10_000),
    );
    fixture.projects.register(fixture.jobs);
    await fixture.jobs.tick();
    await fixture.projects.control(fixture.actor, approval.id, "pause");
    await fixture.close();
    closed = true;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { createProjectFixture } from './test/local/project-fixture.ts';
const f=createProjectFixture(process.argv[1]);
const a=f.projects.list('workspace')[0];
f.projects.register(f.jobs);
f.clock.advance(60000);
await f.jobs.tick();
const paused=f.projects.progress(a.id).every(c=>!f.projects.canDispatch(c.epicId));
await f.projects.control(f.actor,a.id,'resume');
f.clock.advance(60000);
await f.jobs.tick();
console.log(JSON.stringify({paused,started:f.started,claims:f.projects.progress(a.id).length,items:f.db.query('SELECT id FROM work_item').all().length}));
await f.close();`,
        filename,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ paused: true, started: [], claims: 2, items: 2 });
  } finally {
    if (!closed) await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-delegating a failed project issue starts it again and a running one stays claimed", async () => {
  const f = createProjectFixture();
  try {
    const preview = await f.projects.preview(f.actor, f.selection, AbortSignal.timeout(10_000));
    await f.projects.approve(f.actor, preview.id, preview.generation, AbortSignal.timeout(10_000));
    f.projects.register(f.jobs);
    await f.jobs.tick();
    const first = f.projects.progress(preview.id).find((claim) => claim.issueId === "one")!;
    const failed = first.items[0]!.id;
    const created = (sessionId: string): AcceptedLinearEvent => {
      const body = JSON.parse(
        readFileSync(join(import.meta.dir, "fixtures/linear/agent-session-created.json"), "utf8"),
      );
      body.agentSession.id = sessionId;
      return parseAgentEvent(JSON.stringify(body), `delivery-${sessionId}`, f.clock.now())!;
    };
    for (const sessionId of ["early", "again"]) {
      ensureLinearSession(f.db, { sessionId, issueId: "one", creatorId: null });
      recordLinearInstallation(f.db, {
        sessionId,
        organizationId: "org",
        teamId: "team",
        oauthClientId: "client",
        appUserId: "app",
        observedAtMs: f.clock.now(),
      });
    }
    expect(await f.projects.authorizeEvent(created("early"))).toBe(false);
    const notice = f.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM outbox WHERE json_extract(payload,'$.sessionId')='early'",
      )
      .get();
    expect(JSON.parse(notice?.payload ?? "{}").body).toBe(
      "one is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.",
    );
    expect(getWorkItem(f.db, failed)?.state).not.toBe("cancelled");
    f.db.run("UPDATE work_item SET state='failed' WHERE id=?", [failed]);
    expect(await f.projects.authorizeEvent(created("again"))).toBe(true);
    expect(getWorkItem(f.db, failed)?.state).toBe("cancelled");
    await f.orchestrator.intakeLinearTask("one", "again", "again-task");
    const claim = f.projects.progress(preview.id).find((entry) => entry.issueId === "one")!;
    expect(claim.epicId).not.toBe(first.epicId);
    expect(claim.items).toHaveLength(1);
    expect(claim.items[0]!.id).not.toBe(failed);
    expect(f.projects.canDispatch(claim.epicId!)).toBe(true);
  } finally {
    await f.close();
  }
});

function createdEvent(f: ReturnType<typeof createProjectFixture>, sessionId: string) {
  const body = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/linear/agent-session-created.json"), "utf8"),
  );
  body.agentSession.id = sessionId;
  return parseAgentEvent(JSON.stringify(body), `delivery-${sessionId}`, f.clock.now())!;
}

async function approvedProject(f: ReturnType<typeof createProjectFixture>) {
  const preview = await f.projects.preview(f.actor, f.selection, AbortSignal.timeout(10_000));
  await f.projects.approve(f.actor, preview.id, preview.generation, AbortSignal.timeout(10_000));
  f.projects.register(f.jobs);
  await f.jobs.tick();
}

test("a project task whose Linear read fails once is retried and accepted", async () => {
  const f = createProjectFixture(":memory:", { authorizeEvents: true });
  try {
    await approvedProject(f);
    f.failMemberRead();
    const event = createdEvent(f, "session-one");
    const acknowledged = new Set<string>(["session-one"]);
    const deliver = (attempt: number) =>
      acknowledgeNewSession(
        f.tracker,
        event,
        (value) => f.orchestrator.onLinearEvent(value),
        undefined,
        { acknowledged, reportFailure: attempt === 0 },
      );
    await expect(deliver(0)).rejects.toBeInstanceOf(LinearIntakePendingError);
    await deliver(1);
    expect(f.tracker.progress.filter((update) => update.kind === "error")).toEqual([]);
    expect(
      f.db.query("SELECT 1 FROM workspace_access_audit WHERE action='access.denied'").all(),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a refused project takeover posts one message", async () => {
  const f = createProjectFixture(":memory:", { authorizeEvents: true });
  try {
    await approvedProject(f);
    ensureLinearSession(f.db, { sessionId: "early", issueId: "one", creatorId: null });
    recordLinearInstallation(f.db, {
      sessionId: "early",
      organizationId: "org",
      teamId: "team",
      oauthClientId: "client",
      appUserId: "app",
      observedAtMs: f.clock.now(),
    });
    expect(
      await acknowledgeNewSession(f.tracker, createdEvent(f, "early"), (value) =>
        f.orchestrator.onLinearEvent(value),
      ),
    ).toBe(false);
    const posted = [
      ...f.tracker.progress
        .filter((update) => update.sessionId === "early" && update.kind !== "thought")
        .map((update) => update.body),
      ...f.db
        .query<{ body: string }, []>(
          "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE json_extract(payload,'$.sessionId')='early'",
        )
        .all()
        .map((row) => row.body),
    ];
    expect(posted).toEqual([
      "Paws did not start this work. one is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.",
    ]);
  } finally {
    await f.close();
  }
});
