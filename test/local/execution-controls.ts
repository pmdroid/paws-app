import type { Database } from "bun:sqlite";
import { and, asc, eq, like, sql } from "drizzle-orm";
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
  sqliteDb,
  type Db,
  type Q,
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
import { tempStore } from "../pglite";

type FixtureOptions = {
  interruptItem?: (id: string) => Promise<void>;
  onMemberRevoked?: () => Promise<void>;
};

export async function createExecutionControlsFixture(root: string, options: FixtureOptions = {}) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "controls.sqlite"));
  migrate(db);
  return {
    db,
    ...(await executionControlsFixture(db, sqliteDb(db), root, options, async () => db.close())),
  };
}

export async function createExecutionControlsFixturePg(root: string, options: FixtureOptions = {}) {
  mkdirSync(root, { recursive: true });
  const { db, close } = await tempStore();
  return { db, ...(await executionControlsFixture(db, db, root, options, close)) };
}

function write(db: Db, query: (q: Q) => PromiseLike<unknown>) {
  return db.run((q) => q.exec(query(q)));
}

function setMemberActive(db: Db, userId: string, active: number) {
  return write(db, (q) =>
    q.orm
      .update(q.t.workspaceMember)
      .set({ active })
      .where(
        and(
          eq(q.t.workspaceMember.workspaceId, "workspace"),
          eq(q.t.workspaceMember.userId, userId),
        ),
      ),
  );
}

async function executionControlsFixture(
  handle: Database | Db,
  db: Db,
  root: string,
  options: FixtureOptions,
  closeDb: () => Promise<void>,
) {
  const now = Date.now();
  const workspaceId = "workspace";
  await putWorkspaceUser(db, {
    id: "admin",
    linearUserId: "admin",
    name: "Admin",
    email: "admin@example.invalid",
  });
  await consumeWorkspaceBootstrap(db, {
    id: workspaceId,
    organizationId: "org",
    name: "Controls verification",
    userId: "admin",
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const [id, role, teamIds] of [
    ["member", "member", ["team"]],
    ["inactive", "member", ["team"]],
    ["outside", "member", ["outside"]],
  ] as const) {
    await putWorkspaceUser(db, {
      id,
      linearUserId: id,
      name: id,
      email: `${id}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId,
      userId: id,
      role,
      active: true,
      teamIds,
      now,
    });
  }
  const sessions: Record<string, Awaited<ReturnType<typeof issueWorkspaceSession>>> = {};
  for (const userId of ["admin", "member", "inactive", "outside"])
    sessions[userId] = await issueWorkspaceSession(db, { workspaceId, userId, now });
  await setMemberActive(db, "inactive", 0);
  for (const [id, organizationId] of [
    ["controlled", "org"],
    ["foreign", "foreign"],
    ["unmapped", "org"],
  ]) {
    const item = await insertQueuedItem(db, {
      id,
      sessionKey: `session-${id}`,
      title: `Control ${id}`,
      now,
    });
    await recordLinearInstallation(db, {
      sessionId: item.sessionKey!,
      organizationId: organizationId!,
      teamId: "team",
      oauthClientId: "client",
      appUserId: "app",
      observedAtMs: now,
    });
    await bindLinearSessionTask(db, item.sessionKey!, item.delegationId);
  }
  const item = (await getWorkItem(db, "controlled"))!;
  await write(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id: "other",
      delegationId: item.delegationId,
      linearIssueId: "other",
      linearIdentifier: "other",
      title: "Unrelated item",
      state: "queued",
      branchName: "paws/other",
      position: 1,
      createdAt: now,
      sessionKey: item.sessionKey,
    }),
  );
  await bindWorkItemRepository(db, "unmapped", {
    owner: "fixture",
    repo: "unmapped",
    remoteUrl: "https://example.invalid/fixture/unmapped",
  });
  await replaceWorkspaceRepositories(db, {
    workspaceId,
    actorId: "admin",
    repositories: [{ repository: "fixture/allowed", teamId: "team" }],
    now,
  });
  const run = (await beginImplementRun(db, item.id, now)).run;
  const clock = new FakeClock(now);
  const orchestrator = new Orchestrator({
    store: db,
    clock,
    jobs: new JobLoop(handle, clock),
    outbox: new OutboxDispatcher(handle, clock),
    pawsRoot: root,
    tracker: createFakeTracker(),
    scheduling: async () => ({}),
  });
  let joining: Promise<void> | null = null;
  let revokeOnResume = false;
  const controls = createExecutionControls({
    db: handle,
    bus: orchestrator.bus,
    getPort: () => ({
      pauseItem: (id, canAct, onCommitted) => orchestrator.pauseItem(id, canAct, onCommitted),
      async resumeItem(id, canAct, onCommitted) {
        const resumed = orchestrator.resumeItem(id, canAct, onCommitted);
        if (revokeOnResume) await setMemberActive(db, "member", 0);
        return resumed;
      },
      async interruptItem(id) {
        if (joining) await joining;
        await orchestrator.interruptItem(id);
      },
      clearStuckAgent: (id, canAct, onCommitted) =>
        orchestrator.clearStuckAgent(id, canAct, onCommitted),
    }),
  });
  const ready = Promise.withResolvers<WorkspaceAccess>();
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db: handle,
    webhooks: false,
    statusEnv: {},
    workspaceAccess: ready.promise,
    executionControls: controls.handle,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const access = createWorkspaceAccess({
    interruptItem: options.interruptItem,
    onMemberRevoked: options.onMemberRevoked,
    store: db,
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
    store: db,
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
      await closeDb();
    },
  };
}

export async function probeExecutionControls(root: string) {
  const fixture = await createExecutionControlsFixturePg(root);
  const { db, call } = fixture;
  assert(db.dialect === "postgres");
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  const observe = (name: string, observed: unknown) =>
    observations.push({ name, passed: true, observed });
  try {
    assert.equal(
      (await fetch(`${fixture.origin}/api/execution-controls?itemId=controlled`)).status,
      401,
    );
    const none = async (response: Response) => {
      assert.equal(response.status, 200);
      assert.deepEqual(((await response.json()) as { actions: string[] }).actions, []);
    };
    assert.equal((await call(undefined, "inactive")).status, 401);
    await none(await call(undefined, "outside"));
    for (const item of ["foreign", "unmapped"]) await none(await call(undefined, "admin", item));
    assert.equal((await call(undefined, "admin")).status, 200);
    assert.deepEqual(((await (await call()).json()) as { actions: string[] }).actions, [
      "stop",
      "pause",
    ]);
    observe(
      "Production workspace HTTP authorization permits active teammates and admin team bypass while rejecting anonymous, inactive, other-team, organization and repository scopes",
      { admin: 200, member: 200, denied: 5 },
    );
    const resetsAt = Date.now() + 3_600_000;
    await startUsagePause(db, {
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
    assert.equal((await call("resume_now", "inactive")).status, 401);
    assert.equal((await call("resume_now")).status, 200);
    assert((await usagePause(db, fixture.runId))!.resumeAt <= Date.now());
    assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
    await write(db, (q) => q.orm.delete(q.t.usagePause));
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
    assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
    observe("Cross-origin, CSRF and workspace-selection violations fail before canonical effects", {
      state: "running",
    });
    await db.orm.execute(
      sql.raw(
        "CREATE FUNCTION reject_control_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$",
      ),
    );
    await db.orm.execute(
      sql.raw(
        "CREATE TRIGGER reject_control_audit BEFORE INSERT ON workspace_access_audit FOR EACH ROW WHEN (NEW.action='execution.pause') EXECUTE FUNCTION reject_control_audit()",
      ),
    );
    assert.equal((await call("pause")).status, 503);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
    await db.orm.execute(sql.raw("DROP TRIGGER reject_control_audit ON workspace_access_audit"));
    await db.orm.execute(sql.raw("DROP FUNCTION reject_control_audit()"));
    observe("Audit failure rolls back the actual canonical pause transaction before live effects", {
      state: "running",
    });
    assert.equal((await call("pause")).status, 200);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "paused");
    assert.equal((await call("pause")).status, 409);
    assert.equal((await call("resume")).status, 200);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "queued");
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
      count < 100 && (await getWorkItem(db, "controlled"))!.state !== "cancelled";
      count++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal((await getWorkItem(db, "controlled"))!.state, "cancelled");
    assert.equal(returned, false);
    assert.equal((await getWorkItem(db, "other"))!.state, "queued");
    release();
    assert.equal((await stopping).status, 200);
    assert.equal((await call("stop")).status, 409);
    const messages = (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ payload: q.t.outbox.payload })
            .from(q.t.outbox)
            .where(eq(q.t.outbox.deliveryKind, "stop")),
        ),
      )
    ).map((row) => ({ body: (row.payload as { body?: string } | null)?.body ?? null }));
    assert(messages.some((row) => row.body?.startsWith("Stopped from Paws. ")));
    observe(
      "Selected-item Stop commits and awaits interruption, preserves unrelated work and branch, and attributes the Linear response to Paws",
      {
        state: "cancelled",
        other: "queued",
        branch: (await getWorkItem(db, "controlled"))!.branchName,
        messages,
      },
    );
    await write(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ state: "paused", cancelRequested: 0 })
        .where(eq(q.t.workItem.id, "controlled")),
    );
    fixture.revokeDuringResume();
    assert.equal((await call("resume")).status, 409);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "paused");
    observe(
      "Membership revoked during the actual resume join fences its post-join canonical restart",
      { state: "paused" },
    );
    await setMemberActive(db, "member", 1);
    await write(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "running" }).where(eq(q.t.workItem.id, "controlled")),
    );
    const stopRequest = new Request(fixture.origin + "/api/execution-controls", {
      method: "POST",
      headers: fixture.headers(),
      body: JSON.stringify({ itemId: "controlled", action: "stop" }),
    });
    const verified = (await requestWorkspaceSession(db, stopRequest))!;
    const allowed = await workspaceSessionIds(
      db,
      verified.principal.workspaceId,
      verified.principal.userId,
      "client",
    );
    let revoked: Promise<void> | undefined;
    const revoking = createExecutionControls({
      db,
      bus: fixture.orchestrator.bus,
      getPort() {
        revoked = setMemberActive(db, "member", 0);
        return fixture.orchestrator;
      },
    });
    assert.equal((await revoking.handle(stopRequest, verified.principal, allowed))!.status, 409);
    await revoked;
    assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
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
    const audit = await db.run((q) =>
      q.all(
        q.orm
          .select({
            action: q.t.workspaceAccessAudit.action,
            userId: q.t.workspaceAccessAudit.userId,
          })
          .from(q.t.workspaceAccessAudit)
          .where(like(q.t.workspaceAccessAudit.action, "execution.%"))
          .orderBy(asc(q.t.workspaceAccessAudit.id)),
      ),
    );
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
    const fixture = await createExecutionControlsFixturePg(root);
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
