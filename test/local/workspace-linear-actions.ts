import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { request } from "node:https";
import { startPaws } from "../../src/index";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  migrate,
  openDatabase,
  putWorkspaceUser,
  consumeWorkspaceBootstrap,
  syncWorkspaceMember,
  workspaceMember,
  getWorkItem,
  insertQueuedItem,
  beginImplementRun,
  applyWorkItemEvent,
  JobLoop,
  OutboxDispatcher,
  listJobs,
  ensureLinearSession,
  recordLinearInstallation,
  listPendingLinearTurns,
} from "../../src/db";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  workspaceTokenHash,
} from "../../src/workspace";
import {
  createFakeTracker,
  parseAgentEvent,
  type AcceptedLinearEvent,
  type IntakeDecision,
  type LinearMemberIdentity,
} from "../../src/linear";
import { attachOrchestrator } from "../../src/loop";
import { answerQuestion, openQuestion, getQuestion } from "../../src/questions";

type Observe = (name: string, passed: boolean, observed: unknown) => void;

export async function probeWorkspaceLinearActions(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "actions.sqlite"));
  migrate(db);
  let now = Date.now();
  const ownerId = putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: ownerId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const [id, role, active, teams] of [
    ["inactive", "member", false, ["team"]],
    ["member", "member", true, ["team"]],
    ["owner", "member", true, ["team"]],
  ] as const) {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      active,
      role,
      teamIds: teams,
      now,
    });
  }
  const identities = new Map<string, LinearMemberIdentity>();
  const identity = (id: string): LinearMemberIdentity => ({
    userId: id,
    organizationId: "org",
    active: true,
    guest: false,
    admin: false,
    teamIds: ["team"],
  });
  for (const id of [
    "owner",
    "inactive",
    "member",
    "new-member",
    "guest",
    "outside",
    "wrong-org",
    "wrong-user",
  ])
    identities.set(id, identity(id));
  identities.get("guest")!.guest = true;
  identities.get("outside")!.teamIds = [];
  identities.get("wrong-org")!.organizationId = "foreign";
  identities.get("wrong-user")!.userId = "another";
  let delayed: { entered(): void; wait: Promise<void> } | undefined;
  let lookupFails = false;
  const access = createWorkspaceAccess({
    db,
    publicUrl: "http://127.0.0.1",
    clientId: "client",
    installedOrganization: { id: "org", name: "Workspace" },
    now: () => now,
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      async member(_org, id) {
        if (lookupFails) throw new Error("Scripted membership outage");
        const value = structuredClone(identities.get(id)!);
        const barrier = delayed;
        if (barrier) {
          delayed = undefined;
          barrier.entered();
          await barrier.wait;
        }
        return value;
      },
    },
  });
  let serial = 0;
  function task(actor: string | null, signal: string | null = null) {
    const id = `item-${++serial}`,
      sessionId = `session-${serial}`;
    const item = insertQueuedItem(db, { id, sessionKey: sessionId, title: "Export rows" });
    ensureLinearSession(db, { sessionId, issueId: id, now });
    recordLinearInstallation(db, {
      sessionId,
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: now,
    });
    beginImplementRun(db, item.id, now - 10);
    applyWorkItemEvent(db, item.id, "blocking_question");
    const question = openQuestion(db, {
      itemId: item.id,
      sessionId,
      body: "Include archived rows?",
      now,
    });
    const event = parseAgentEvent(
      JSON.stringify({
        type: "AgentSessionEvent",
        action: "prompted",
        webhookTimestamp: now + 100,
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        agentSession: { id: sessionId, issue: { id, team: { id: "team" } } },
        agentActivity: {
          id: `activity-${serial}`,
          userId: actor,
          signal,
          createdAt: new Date(now + 1).toISOString(),
          content: { type: "prompt", body: "Yes" },
        },
      }),
      `delivery-${serial}`,
      now + 100,
    )!;
    return { item, question, event };
  }
  const clock = new FakeClock(now);
  const loop = attachOrchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    tracker: createFakeTracker(),
    clock,
    authorizeLinearEvent: decide(access.authorizeLinearEvent),
    recheckLinearEvent: access.recheckLinearEvent,
  });
  const resumes = () => listJobs(db).filter((j) => j.queue === JOB_KIND.resume).length;
  const audits = () =>
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM workspace_access_audit WHERE action='access.denied'",
      )
      .get()!.count;
  try {
    for (const actor of ["inactive", "guest", "outside", "wrong-org", "wrong-user", null]) {
      const t = task(actor),
        before = audits();
      await loop.onLinearEvent(t.event);
      observe(
        `Linear actor ${actor ?? "missing"} cannot answer or resume`,
        getQuestion(db, t.question.id)?.status === "open" &&
          resumes() === 0 &&
          audits() === before + 1,
        {
          question: getQuestion(db, t.question.id)?.status,
          resumes: resumes(),
          audits: audits() - before,
        },
      );
    }
    identities.get("owner")!.teamIds = [];
    const outsideOwner = task("owner");
    await loop.onLinearEvent(outsideOwner.event);
    observe(
      "workspace ownership cannot bypass mapped Linear team membership",
      getQuestion(db, outsideOwner.question.id)?.status === "open" && resumes() === 0,
      { role: workspaceMember(db, "workspace", "owner")?.role },
    );
    identities.get("owner")!.teamIds = ["team"];
    const positive = task("new-member");
    await loop.onLinearEvent(positive.event);
    await loop.onLinearEvent(positive.event);
    observe(
      "verified in-team Linear actor answers once without a Paws browser identity",
      getQuestion(db, positive.question.id)?.answeredBy === "new-member" &&
        resumes() === 1 &&
        workspaceMember(db, "workspace", "new-member") === null,
      { answer: getQuestion(db, positive.question.id)?.answeredBy, resumes: resumes() },
    );
    const stop = task("inactive", "stop"),
      beforeStop = audits();
    await loop.onLinearEvent(stop.event);
    observe(
      "an inactive member's stop signal cannot cancel canonical work",
      getQuestion(db, stop.question.id)?.status === "open" && audits() === beforeStop + 1,
      { question: getQuestion(db, stop.question.id)?.status },
    );
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    delayed = { entered: entered.resolve, wait: release.promise };
    const changed = task("member"),
      pending = loop.onLinearEvent(changed.event);
    await entered.promise;
    now++;
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      active: false,
      role: "member",
      teamIds: ["team"],
      now,
    });
    release.resolve();
    await pending;
    observe(
      "membership demotion during verified actor lookup prevents answer",
      getQuestion(db, changed.question.id)?.status === "open" && resumes() === 1,
      {
        question: getQuestion(db, changed.question.id)?.status,
        role: workspaceMember(db, "workspace", "member")?.role,
      },
    );
    const unavailable = task("new-member"),
      beforeUnavailable = audits();
    lookupFails = true;
    let rejected = false;
    try {
      await loop.onLinearEvent(unavailable.event);
    } catch {
      rejected = true;
    }
    lookupFails = false;
    observe(
      "transient membership failure leaves the same answer retryable",
      rejected &&
        getQuestion(db, unavailable.question.id)?.status === "open" &&
        audits() === beforeUnavailable,
      { rejected },
    );
    await loop.onLinearEvent(unavailable.event);
    observe(
      "repaired membership lookup accepts exact retry once",
      getQuestion(db, unavailable.question.id)?.status === "answered" && resumes() === 2,
      { resumes: resumes() },
    );
    const removeOwnerTeam = () => {
      now++;
      syncWorkspaceMember(db, {
        workspaceId: "workspace",
        userId: "owner",
        active: true,
        role: "member",
        teamIds: [],
        now,
      });
    };
    const restoreOwnerTeam = () =>
      syncWorkspaceMember(db, {
        workspaceId: "workspace",
        userId: "owner",
        active: true,
        role: "member",
        teamIds: ["team"],
        now,
      });
    const queued = task("owner");
    let calls = 0;
    const queueLoop = attachOrchestrator({
      db,
      jobs: new JobLoop(db, clock),
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: root,
      tracker: createFakeTracker(),
      clock,
      authorizeLinearEvent: async (event) => {
        calls++;
        const decision = await decide(access.authorizeLinearEvent)(event);
        removeOwnerTeam();
        return decision;
      },
      recheckLinearEvent: access.recheckLinearEvent,
    });
    await queueLoop.onLinearEvent(queued.event);
    observe(
      "queued execution rechecks stored membership after one Linear authorization",
      calls === 1 &&
        getQuestion(db, queued.question.id)?.status === "open" &&
        resumes() === 2 &&
        listPendingLinearTurns(db, queued.event.sessionId!).length === 0,
      { calls, question: getQuestion(db, queued.question.id)?.status, resumes: resumes() },
    );
    await queueLoop.shutdown();
    restoreOwnerTeam();
    const followup = task("owner");
    answerQuestion(db, followup.question.id, {
      answer: "Earlier answer",
      answeredBy: "owner",
      eventKey: "earlier-answer",
      now,
    });
    let followupCalls = 0;
    const followupLoop = attachOrchestrator({
      db,
      jobs: new JobLoop(db, clock),
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: root,
      tracker: createFakeTracker(),
      clock,
      authorizeLinearEvent: async (event) => {
        followupCalls++;
        const decision = await decide(access.authorizeLinearEvent)(event);
        removeOwnerTeam();
        return decision;
      },
      recheckLinearEvent: access.recheckLinearEvent,
    });
    await followupLoop.onLinearEvent(followup.event);
    const turn = db
      .query<{ state: string }, [string]>("SELECT state FROM linear_turn WHERE event_key=?")
      .get(followup.event.dedupeKey);
    observe(
      "a follow-up revoked before queued execution cannot survive as pending steering",
      followupCalls === 1 &&
        turn?.state === "cancelled" &&
        listPendingLinearTurns(db, followup.event.sessionId!).length === 0,
      { calls: followupCalls, turn },
    );
    await followupLoop.shutdown();
  } finally {
    writeFileSync(
      join(root, "audit.json"),
      JSON.stringify(db.query("SELECT * FROM workspace_access_audit").all(), null, 2),
    );
    await loop.shutdown();
    await access.stop();
    db.close();
  }
  await probeWorkspaceLinearHttps(join(root, "https"), observe);
}

async function probeWorkspaceLinearHttps(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = join(root, "local.key"),
    cert = join(root, "local.crt");
  const generated = Bun.spawnSync(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: root } },
  );
  if (generated.exitCode !== 0) throw new Error("Local TLS fixture generation failed");
  chmodSync(key, 0o600);
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  const port = reservation.port!;
  await reservation.stop(true);
  const nativeFetch = globalThis.fetch;
  let polled: unknown[] = [];
  const reads: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: unknown, init?: RequestInit) => {
      if (String(input) !== "https://api.linear.app/graphql")
        throw new Error("Unscripted request rejected");
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { id?: string };
      };
      reads.push(query.split(" {")[0]!);
      const connection = (nodes: unknown[]) => ({
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      });
      const metadata = { team: { id: "team" }, project: null, assignee: null, priority: 0 };
      if (query.includes("IssueSnapshot"))
        return Response.json({
          data: {
            issue: {
              id: variables.id,
              identifier: variables.id,
              title: "Export rows",
              description: null,
              ...metadata,
              children: connection([]),
            },
          },
        });
      if (query.includes("IssueRelations"))
        return Response.json({
          data: {
            issue: {
              id: variables.id,
              relations: connection([]),
              inverseRelations: connection([]),
            },
          },
        });
      if (query.includes("IssueOwnership"))
        return Response.json({
          data: {
            issue: {
              id: variables.id,
              ...metadata,
              state: { type: "started" },
              delegate: { id: "app" },
            },
          },
        });
      const viewer = { id: "app", app: true, organization: { id: "org", name: "Workspace" } };
      if (query.includes("PawsBrowserInstallation")) return Response.json({ data: { viewer } });
      if (query.includes("PawsBrowserMembership"))
        return Response.json({
          data: {
            viewer,
            user: {
              id: variables.id,
              active: true,
              guest: false,
              admin: false,
              organization: { id: "org" },
              teams: {
                nodes: variables.id === "outside" ? [] : [{ id: "team" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      if (query.includes("PawsSessionInstallation"))
        return Response.json({
          data: {
            viewer,
            agentSession: {
              id: variables.id,
              appUser: viewer,
              issue: { id: variables.id, team: { id: "team" } },
            },
          },
        });
      if (query.includes("PawsTeamAccess"))
        return Response.json({ data: { team: { id: "team" } } });
      if (query.includes("IntakePoll")) {
        const activities = polled;
        polled = [];
        return Response.json({
          data: {
            viewer,
            issues: connection([]),
            comments: connection([]),
            agentSessions: connection([]),
            agentActivities: connection(activities),
          },
        });
      }
      if (query.includes("agentActivityCreate"))
        return Response.json({
          data: {
            agentActivityCreate: { success: true, agentActivity: { id: "fixture-progress" } },
          },
        });
      throw new Error("Unscripted Linear operation rejected");
    },
    { preconnect: () => undefined },
  );
  const paws = startPaws({
    PAWS_HOME: root,
    PAWS_HOST: "127.0.0.1",
    PAWS_PORT: String(port),
    PAWS_PUBLIC_DASHBOARD: "1",
    PAWS_PUBLIC_URL: `https://127.0.0.1:${port}`,
    PAWS_TLS_KEY_PATH: key,
    PAWS_TLS_CERT_PATH: cert,
    LINEAR_MODE: "agent-session",
    LINEAR_CLIENT_ID: "client",
    LINEAR_ACCESS_TOKEN: "fixture-access",
    LINEAR_APP_USER_ID: "app",
    LINEAR_TEAM_ID: "team",
    LINEAR_WEBHOOKS: "true",
    LINEAR_WEBHOOK_SECRET: "fixture-signing",
  });
  const db = paws.db,
    now = Date.now();
  putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  putWorkspaceUser(db, {
    id: "inactive",
    linearUserId: "inactive",
    name: "Inactive",
    email: "inactive@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "workspace",
    userId: "inactive",
    active: false,
    role: "member",
    teamIds: [],
    now,
  });
  let sequence = 0;
  function task(actor: string, signal: string | null = null) {
    const id = `native-${++sequence}`,
      at = Date.now();
    const item = insertQueuedItem(db, { id, sessionKey: id, title: "Export rows" });
    ensureLinearSession(db, { sessionId: id, issueId: id, now: at });
    recordLinearInstallation(db, {
      sessionId: id,
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: at,
    });
    beginImplementRun(db, id, at - 10);
    applyWorkItemEvent(db, id, "blocking_question");
    const question = openQuestion(db, {
      itemId: id,
      sessionId: id,
      body: "Include archived rows?",
      now: at - 1,
    });
    const activity = {
      id: `native-activity-${sequence}`,
      userId: actor,
      user: { id: actor },
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      signal,
      content: { type: "prompt", body: "Yes" },
      agentSession: { id, issue: { id } },
    };
    const payload = JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      webhookTimestamp: at,
      agentSession: { id, issue: { id, team: { id: "team" } } },
      agentActivity: activity,
    });
    return { item, question, activity, payload };
  }
  const send = (body: string, valid = true) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/webhooks/linear",
          method: "POST",
          ca: readFileSync(cert),
          rejectUnauthorized: true,
          headers: {
            "linear-delivery": `delivery-${sequence}-${valid}`,
            "linear-signature": valid
              ? createHmac("sha256", "fixture-signing").update(body).digest("hex")
              : "0".repeat(64),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error("Local HTTPS timed out")));
      req.on("error", reject);
      req.end(body);
    });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Expected local event did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const denied = () =>
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM workspace_access_audit WHERE action='access.denied'",
      )
      .get()!.count;
  const startup = Date.now() + 3000;
  while (
    ["scheduler.tick", "linear.epics.reconcile"].some(
      (queue) => !listJobs(db).some((job) => job.queue === queue && job.fireCount >= 1),
    )
  ) {
    if (Date.now() > startup) throw new Error("Startup reconcile did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    const invalid = task("inactive");
    const invalidStatus = await send(invalid.payload, false);
    observe(
      "normal protected HTTPS rejects an unsigned human action",
      invalidStatus === 401 && getQuestion(db, invalid.question.id)?.status === "open",
      { status: invalidStatus },
    );
    for (const [actor, signal] of [
      ["inactive", null],
      ["outside", "stop"],
    ] as const) {
      const t = task(actor, signal),
        before = denied();
      const status = await send(t.payload);
      await until(() => denied() > before);
      observe(
        `normal signed HTTPS denies ${actor} ${signal ?? "answer"} semantically without retrying delivery`,
        status === 200 &&
          getQuestion(db, t.question.id)?.status === "open" &&
          listJobs(db).filter((j) => j.queue === JOB_KIND.resume).length === 0,
        {
          status,
          question: getQuestion(db, t.question.id)?.status,
          denialAudits: denied() - before,
        },
      );
    }
    const stopped = task("inactive", "stop"),
      before = denied();
    polled = [stopped.activity];
    await paws.catchUp();
    observe(
      "normal catch-up denial cannot reach the poller stop fallback",
      denied() === before + 1 &&
        getQuestion(db, stopped.question.id)?.status === "open" &&
        listJobs(db).filter((j) => j.queue === JOB_KIND.command).length === 0,
      {
        question: getQuestion(db, stopped.question.id)?.status,
        denials: denied() - before,
        commands: listJobs(db).filter((j) => j.queue === JOB_KIND.command).length,
      },
    );
    const allowed = task("new-member");
    polled = [allowed.activity];
    await paws.catchUp();
    await until(() => getQuestion(db, allowed.question.id)?.status === "answered");
    polled = [allowed.activity];
    await paws.catchUp();
    observe(
      "normal catch-up permits a verified teammate without a browser identity exactly once",
      getQuestion(db, allowed.question.id)?.answeredBy === "new-member" &&
        listJobs(db).filter((j) => j.jobKey === `resume:answer:${allowed.question.id}`).length ===
          1 &&
        workspaceMember(db, "workspace", "new-member") === null,
      {
        answeredBy: getQuestion(db, allowed.question.id)?.answeredBy,
        resumes: listJobs(db).filter((j) => j.jobKey === `resume:answer:${allowed.question.id}`)
          .length,
      },
    );
    const permittedStop = task("new-member", "stop");
    polled = [permittedStop.activity];
    await paws.catchUp();
    observe(
      "normal catch-up retains canonical Stop for an authorized teammate",
      getQuestion(db, permittedStop.question.id)?.status === "cancelled" &&
        getWorkItem(db, permittedStop.item.id)?.state === "cancelled",
      {
        question: getQuestion(db, permittedStop.question.id)?.status,
        state: getWorkItem(db, permittedStop.item.id)?.state,
      },
    );
  } finally {
    await paws.stop();
    globalThis.fetch = nativeFetch;
    writeFileSync(join(root, "requests.json"), JSON.stringify(reads, null, 2));
  }
}

function decide(authorize: (event: AcceptedLinearEvent) => Promise<boolean>) {
  return async (event: AcceptedLinearEvent): Promise<IntakeDecision> =>
    (await authorize(event)) ? { outcome: "accepted" } : { outcome: "refused", reason: "denied" };
}
