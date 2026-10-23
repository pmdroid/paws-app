import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeClock } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  startUsagePause,
  usagePause,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
  workspaceSessionIds,
} from "../../src/db";
import { createExecutionControls } from "../../src/execution-controls";
import { createFakeTracker, createLinearMembershipReads } from "../../src/linear";
import { Orchestrator } from "../../src/loop";
import { startServer } from "../../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  requestWorkspaceSession,
  WORKSPACE_COOKIE,
  type WorkspaceAccess,
} from "../../src/workspace";

export function createExecutionControlsFixture(root: string) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "controls.sqlite"));
  migrate(db);
  const now = Date.now();
  const workspaceId = "workspace";
  putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  consumeWorkspaceBootstrap(db, {
    id: workspaceId,
    organizationId: "org",
    name: "Controls verification",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const [id, role, teamIds] of [
    ["member", "member", ["team"]],
    ["observer", "observer", ["team"]],
    ["outside", "member", ["outside"]],
  ] as const) {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
    syncWorkspaceMember(db, { workspaceId, userId: id, role, active: true, teamIds, now });
  }
  const sessions = Object.fromEntries(
    ["owner", "member", "observer", "outside"].map((userId) => [
      userId,
      issueWorkspaceSession(db, { workspaceId, userId, now }),
    ]),
  );
  for (const [id, organizationId] of [
    ["controlled", "org"],
    ["foreign", "foreign"],
    ["unmapped", "org"],
  ]) {
    const item = insertQueuedItem(db, {
      id,
      sessionKey: `session-${id}`,
      title: `Control ${id}`,
      now,
    });
    recordLinearInstallation(db, {
      sessionId: item.sessionKey!,
      organizationId: organizationId!,
      teamId: "team",
      oauthClientId: "client",
      appUserId: "app",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, item.sessionKey!, item.delegationId);
  }
  const item = getWorkItem(db, "controlled")!;
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key)
    VALUES('other',?,'other','other','Unrelated item','queued','paws/other',1,?,?)`,
    [item.delegationId, now, item.sessionKey],
  );
  bindWorkItemRepository(db, "unmapped", {
    owner: "fixture",
    repo: "unmapped",
    remoteUrl: "https://example.invalid/fixture/unmapped",
  });
  replaceWorkspaceRepositories(db, {
    workspaceId,
    actorId: "owner",
    repositories: [{ repository: "fixture/allowed", teamId: "team" }],
    now,
  });
  const run = beginImplementRun(db, item.id, now).run;
  const clock = new FakeClock(now);
  const orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    tracker: createFakeTracker(),
    scheduling: () => ({}),
  });
  let joining: Promise<void> | null = null;
  let revokeOnResume = false;
  const controls = createExecutionControls({
    db,
    bus: orchestrator.bus,
    getPort: () => ({
      pauseItem: (id, canAct, onCommitted) => orchestrator.pauseItem(id, canAct, onCommitted),
      resumeItem(id, canAct, onCommitted) {
        const resumed = orchestrator.resumeItem(id, canAct, onCommitted);
        if (revokeOnResume)
          db.run("UPDATE workspace_member SET active=0 WHERE workspace_id=? AND user_id='member'", [
            workspaceId,
          ]);
        return resumed;
      },
      async interruptItem(id) {
        if (joining) await joining;
        await orchestrator.interruptItem(id);
      },
    }),
  });
  const ready = Promise.withResolvers<WorkspaceAccess>();
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    statusEnv: {},
    workspaceAccess: ready.promise,
    executionControls: controls.handle,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const access = createWorkspaceAccess({
    db,
    publicUrl: origin,
    clientId: "client",
    installedOrganization: { id: "org", name: "Controls verification" },
    memberships: createLinearMembershipReads({
      async query() {
        throw new Error("Unexpected hosted membership call");
      },
    }),
  });
  ready.resolve(access);
  function headers(identity = "member") {
    const session = sessions[identity]!;
    return {
      cookie: `${WORKSPACE_COOKIE}=${session.token}`,
      origin,
      "x-paws-csrf": session.session.csrfToken,
      "content-type": "application/json",
    };
  }
  async function call(
    action?: string,
    identity = "member",
    itemId = "controlled",
    extra: Record<string, string> = {},
  ) {
    return fetch(`${origin}/api/execution-controls${action ? "" : `?itemId=${itemId}`}`, {
      method: action ? "POST" : "GET",
      headers: { ...headers(identity), ...extra },
      ...(action ? { body: JSON.stringify({ itemId, action }) } : {}),
    });
  }
  return {
    db,
    orchestrator,
    origin,
    runId: run.id,
    sessions,
    headers,
    call,
    setJoin(value: Promise<void> | null) {
      joining = value;
    },
    revokeDuringResume() {
      revokeOnResume = true;
    },
    async close() {
      await server.stop(true);
      await access.stop();
      await orchestrator.shutdown();
      db.close();
    },
  };
}

export async function probeExecutionControls(root: string) {
  const fixture = createExecutionControlsFixture(root);
  const { db, call } = fixture;
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  const observe = (name: string, observed: unknown) =>
    observations.push({ name, passed: true, observed });
  try {
    assert.equal(
      (await fetch(`${fixture.origin}/api/execution-controls?itemId=controlled`)).status,
      401,
    );
    for (const identity of ["observer", "outside"])
      assert.equal((await call(undefined, identity)).status, 403);
    for (const item of ["foreign", "unmapped"])
      assert.equal((await call(undefined, "owner", item)).status, 403);
    assert.equal((await call(undefined, "owner")).status, 200);
    assert.deepEqual(((await (await call()).json()) as { actions: string[] }).actions, [
      "stop",
      "pause",
    ]);
    observe(
      "Production workspace HTTP authorization permits active teammates and owner team bypass while rejecting anonymous, observer, other-team, organization and repository scopes",
      { owner: 200, member: 200, denied: 5 },
    );
    const resetsAt = Date.now() + 3_600_000;
    startUsagePause(db, {
      runId: fixture.runId,
      itemId: "controlled",
      agent: "claude",
      runnerId: null,
      resetsAt,
      resumeAt: resetsAt + 60_000,
      pausedAt: Date.now(),
    });
    assert.deepEqual(((await (await call()).json()) as { actions: string[] }).actions, [
      "stop",
      "resume_now",
    ]);
    assert.equal((await call("resume_now", "observer")).status, 403);
    assert.equal((await call("resume_now")).status, 200);
    assert(usagePause(db, fixture.runId)!.resumeAt <= Date.now());
    assert.equal(getWorkItem(db, "controlled")!.state, "running");
    db.run("DELETE FROM usage_pause");
    assert.equal((await call("resume_now")).status, 409);
    observe("Resume now ends a usage-limit wait without changing the item state", {
      state: "running",
    });
    for (const extra of [
      { origin: "https://example.invalid" },
      { "x-paws-csrf": "wrong" },
      { "x-paws-workspace": "foreign" },
    ] as Record<string, string>[])
      assert.equal((await call("stop", "member", "controlled", extra)).status, 403);
    assert.equal(getWorkItem(db, "controlled")!.state, "running");
    observe("Cross-origin, CSRF and workspace-selection violations fail before canonical effects", {
      state: "running",
    });
    db.run(
      "CREATE TEMP TRIGGER reject_control_audit BEFORE INSERT ON workspace_access_audit WHEN NEW.action='execution.pause' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END",
    );
    assert.equal((await call("pause")).status, 503);
    assert.equal(getWorkItem(db, "controlled")!.state, "running");
    db.run("DROP TRIGGER reject_control_audit");
    observe("Audit failure rolls back the actual canonical pause transaction before live effects", {
      state: "running",
    });
    assert.equal((await call("pause")).status, 200);
    assert.equal(getWorkItem(db, "controlled")!.state, "paused");
    assert.equal((await call("pause")).status, 409);
    assert.equal((await call("resume")).status, 200);
    assert.equal(getWorkItem(db, "controlled")!.state, "queued");
    observe(
      "Public Pause and Resume reach actual canonical orchestrator ports and reject stale duplicate actions",
      { state: "queued" },
    );
    let release!: () => void;
    fixture.setJoin(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let returned = false;
    const stopping = call("stop").then((response) => {
      returned = true;
      return response;
    });
    for (
      let count = 0;
      count < 100 && getWorkItem(db, "controlled")!.state !== "cancelled";
      count++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(getWorkItem(db, "controlled")!.state, "cancelled");
    assert.equal(returned, false);
    assert.equal(getWorkItem(db, "other")!.state, "queued");
    release();
    assert.equal((await stopping).status, 200);
    assert.equal((await call("stop")).status, 409);
    const messages = db
      .query<{ body: string }, []>(
        "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE delivery_kind='stop'",
      )
      .all();
    assert(messages.some((row) => row.body === "Stopped from Paws."));
    observe(
      "Selected-item Stop commits and awaits interruption, preserves unrelated work and branch, and attributes the Linear response to Paws",
      {
        state: "cancelled",
        other: "queued",
        branch: getWorkItem(db, "controlled")!.branchName,
        messages,
      },
    );
    db.run("UPDATE work_item SET state='paused',cancel_requested=0 WHERE id='controlled'");
    fixture.revokeDuringResume();
    assert.equal((await call("resume")).status, 409);
    assert.equal(getWorkItem(db, "controlled")!.state, "paused");
    observe(
      "Membership revoked during the actual resume join fences its post-join canonical restart",
      { state: "paused" },
    );
    db.run("UPDATE workspace_member SET active=1 WHERE user_id='member'");
    db.run("UPDATE work_item SET state='running' WHERE id='controlled'");
    const stopRequest = new Request(fixture.origin + "/api/execution-controls", {
      method: "POST",
      headers: fixture.headers(),
      body: JSON.stringify({ itemId: "controlled", action: "stop" }),
    });
    const verified = requestWorkspaceSession(db, stopRequest)!;
    const allowed = workspaceSessionIds(
      db,
      verified.principal.workspaceId,
      verified.principal.userId,
      "client",
    );
    const revoking = createExecutionControls({
      db,
      bus: fixture.orchestrator.bus,
      getPort() {
        db.run("UPDATE workspace_member SET active=0 WHERE user_id='member'");
        return fixture.orchestrator;
      },
    });
    assert.equal((await revoking.handle(stopRequest, verified.principal, allowed))!.status, 409);
    assert.equal(getWorkItem(db, "controlled")!.state, "running");
    observe(
      "Stop rechecks current membership inside its committing transaction after initial authorization",
      { state: "running", status: 409 },
    );
    const anonymous = startServer({
      hostname: "127.0.0.1",
      port: 0,
      webhooks: false,
      executionControls: async () => {
        throw new Error("Unprotected controls invoked");
      },
    });
    try {
      assert.equal(
        (await fetch(`http://127.0.0.1:${anonymous.port}/api/execution-controls?itemId=controlled`))
          .status,
        404,
      );
    } finally {
      await anonymous.stop(true);
    }
    observe("Unbound demo engines cannot route execution controls", { status: 404 });
    const audit = db
      .query<{ action: string; userId: string }, []>(
        "SELECT action,user_id AS userId FROM workspace_access_audit WHERE action LIKE 'execution.%'",
      )
      .all();
    assert.deepEqual(
      audit.map((row) => row.action),
      ["execution.resume_now", "execution.pause", "execution.resume", "execution.stop"],
    );
    assert(audit.every((row) => row.userId === "member"));
    observe(
      "Completed control mutations retain the actual workspace actor in audit history",
      audit,
    );
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    await fixture.close();
  }
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-controls-"));
  if (process.argv.includes("--serve")) {
    const fixture = createExecutionControlsFixture(root);
    console.log(
      JSON.stringify({
        root,
        origin: fixture.origin,
        runId: fixture.runId,
        cookie: WORKSPACE_COOKIE,
        sessions: Object.fromEntries(
          Object.entries(fixture.sessions).map(([id, value]) => [id, value.token]),
        ),
      }),
    );
    const close = async () => {
      await fixture.close();
      process.exit();
    };
    process.on("SIGINT", () => void close());
    process.on("SIGTERM", () => void close());
    setTimeout(() => void close(), 300_000);
  } else console.log(JSON.stringify({ root, observations: await probeExecutionControls(root) }));
}
