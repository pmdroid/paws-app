import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditWorkspaceAccess,
  consumeWorkspaceBootstrap,
  changeLinearTeamAccess,
  bindWorkItemRepository,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  replaceWorkspaceRepositories,
  saveArtifact,
  syncWorkspaceMember,
  workspaceMember,
} from "../../src/db";
import { createLinearMembershipReads } from "../../src/linear";
import { startServer } from "../../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
  type WorkspaceAccess,
} from "../../src/workspace";

export async function probeWorkspaceAuthorization(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "authorization.sqlite"));
  migrate(db);
  const now = Date.now();
  const ownerId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const memberId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  const adminId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "administrator",
    name: "Workspace administrator",
    email: "administrator@example.invalid",
  });
  const workspace = { id: workspaceId(), organizationId: "org", name: "Workspace" };
  consumeWorkspaceBootstrap(db, {
    ...workspace,
    userId: ownerId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: ["team-a"],
    now,
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: adminId,
    role: "admin",
    active: true,
    teamIds: ["team-a"],
    now,
  });
  const owner = issueWorkspaceSession(db, { workspaceId: workspace.id, userId: ownerId, now });
  const member = issueWorkspaceSession(db, { workspaceId: workspace.id, userId: memberId, now });
  const admin = issueWorkspaceSession(db, { workspaceId: workspace.id, userId: adminId, now });
  const oldOwner = issueWorkspaceSession(db, {
    workspaceId: workspace.id,
    userId: ownerId,
    now: now - 16 * 60_000,
  });
  for (const [id, organizationId, teamId] of [
    ["own", "org", "team-a"],
    ["other-team", "org", "team-b"],
    ["unmapped-repo", "org", "team-a"],
    ["foreign", "foreign-org", "team-a"],
    ["other-installation", "org", "team-a"],
    ["unknown", null, null],
  ]) {
    const item = insertQueuedItem(db, {
      id: id!,
      sessionKey: `session-${id}`,
      title: `${id} private content`,
    });
    if (organizationId !== null)
      recordLinearInstallation(db, {
        sessionId: item.sessionKey!,
        organizationId: organizationId!,
        teamId: teamId!,
        appUserId: "app",
        oauthClientId: id === "other-installation" ? "foreign-client" : "client",
        observedAtMs: now,
      });
  }
  for (const [id, repo] of [
    ["own", "allowed"],
    ["unmapped-repo", "private"],
  ])
    bindWorkItemRepository(db, id!, {
      owner: "fixture",
      repo: repo!,
      remoteUrl: `https://example.invalid/fixture/${repo}`,
    });
  replaceWorkspaceRepositories(db, {
    workspaceId: workspace.id,
    actorId: ownerId,
    repositories: [{ repository: "fixture/allowed", teamId: "team-a" }],
    now,
  });
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  for (const [index, itemId] of ["own", "foreign"].entries())
    saveArtifact(
      db,
      {
        id: ids[index]!,
        itemId,
        runId: "fixture-run",
        path: "fixture.txt",
        displayName: `${itemId}.txt`,
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: "a".repeat(64),
        state: "pending",
        assetUrl: null,
      },
      now,
    );
  const ready = Promise.withResolvers<WorkspaceAccess>();
  const reads: string[] = [];
  let probes = 0;
  let membershipFailure = false;
  const runnerCalls: { userId: string; workspaceId: string }[] = [];
  let enrollments = 0;
  let memberTeams = ["team-a"];
  let guest = false;
  let memberReadBarrier: { entered: () => void; wait: Promise<void> } | undefined;
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    statusEnv: {},
    workspaceAccess: ready.promise,
    runnerEnrollment: async (request) => {
      enrollments++;
      return Response.json({ enrollment: request.method }, { status: 202 });
    },
    runnerControl: async (_request, principal) => {
      runnerCalls.push({ userId: principal.userId, workspaceId: principal.workspaceId });
      return Response.json({ ok: true });
    },
    agentSettings: {
      configPath: join(root, "config.toml"),
      probe: async (profile) => {
        probes++;
        return {
          ok: true,
          agent: profile.agent,
          model: profile.model,
          models: [],
          message: "Fixture",
        };
      },
    },
    readLinearArtifact: async (id) => {
      reads.push(id);
      return {
        bytes: new TextEncoder().encode("proof"),
        mimeType: "text/plain",
        displayName: "fixture.txt",
      };
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const access = createWorkspaceAccess({
    db,
    publicUrl: origin,
    clientId: "client",
    installedOrganization: { id: "org", name: "Workspace" },
    verifyTeam: async (id) => id === "team-a" || id === "team-b",
    memberships: createLinearMembershipReads({
      async query(_query, variables) {
        if (membershipFailure) throw new Error("Linear unavailable");
        const result = {
          viewer: { app: true, organization: { id: "org" } },
          user: {
            id: variables?.["id"],
            active: true,
            guest: variables?.["id"] === "member" && guest,
            admin: false,
            organization: { id: "org" },
            teams: {
              nodes: (variables?.["id"] === "member" ? memberTeams : ["team-a"]).map((id) => ({
                id,
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
        if (variables?.["id"] === "member" && memberReadBarrier !== undefined) {
          const barrier = memberReadBarrier;
          memberReadBarrier = undefined;
          barrier.entered();
          await barrier.wait;
        }
        return result;
      },
    }),
  });
  ready.resolve(access);
  const headers = (session: typeof owner) => ({
    cookie: `${WORKSPACE_COOKIE}=${session.token}`,
    origin,
    "x-paws-csrf": session.session.csrfToken,
    "content-type": "application/json",
  });
  try {
    for (let index = 0; index < 105; index++)
      auditWorkspaceAccess(db, {
        workspaceId: workspace.id,
        userId: ownerId,
        action: "fixture.changed",
        subject: `record-${index}`,
        now,
      });
    auditWorkspaceAccess(db, {
      workspaceId: null,
      userId: null,
      action: "fixture.changed",
      subject: "outside-workspace",
      now,
    });
    const auditResponse = await fetch(`${origin}/api/workspaces/audit`, {
      headers: headers(owner),
    });
    const history = (await auditResponse.json().catch(() => ({}))) as {
      entries?: { id: number; actorId: string | null; actorName: string | null; subject: string }[];
      nextBefore?: number | null;
    };
    const entries = history.entries ?? [];
    observe(
      "owners read bounded workspace audit history with actors and a stable older cursor",
      auditResponse.status === 200 &&
        auditResponse.headers.get("cache-control") === "no-store" &&
        entries.length === 50 &&
        entries.every((entry) => entry.actorId === ownerId && entry.actorName === "Owner") &&
        entries[0]?.subject === "record-104" &&
        history.nextBefore === entries.at(-1)?.id,
      { status: auditResponse.status, entries: entries.length, nextBefore: history.nextBefore },
    );
    if (history.nextBefore !== undefined && history.nextBefore !== null) {
      auditWorkspaceAccess(db, {
        workspaceId: workspace.id,
        userId: ownerId,
        action: "fixture.changed",
        subject: "newer-than-first-page",
        now,
      });
      const older = (await (
        await fetch(`${origin}/api/workspaces/audit?before=${history.nextBefore}`, {
          headers: headers(owner),
        })
      ).json()) as typeof history;
      observe(
        "audit pagination excludes concurrent newer entries without repeating a row",
        older.entries?.length === 50 &&
          older.entries.every((entry) => entry.id < history.nextBefore!) &&
          older.entries[0]?.subject === "record-54",
        { first: older.entries?.[0], count: older.entries?.length },
      );
    }
    const auditStatuses = await Promise.all(
      [
        fetch(`${origin}/api/workspaces/audit`, { headers: headers(admin) }),
        fetch(`${origin}/api/workspaces/audit`, { headers: headers(member) }),
        fetch(`${origin}/api/workspaces/audit`),
        fetch(`${origin}/api/workspaces/audit?workspaceId=another-workspace`, {
          headers: headers(owner),
        }),
        fetch(`${origin}/api/workspaces/audit?before=1e3`, { headers: headers(owner) }),
        fetch(`${origin}/api/workspaces/audit`, { method: "PUT", headers: headers(owner) }),
      ].map(async (response) => (await response).status),
    );
    observe(
      "audit reads admit administrators and reject members, anonymous, cross-workspace and invalid requests",
      auditStatuses.join() === "200,403,401,403,400,405",
      auditStatuses,
    );
    const anonymous = await fetch(`${origin}/api/status`);
    const ownerResponse = await fetch(`${origin}/api/status`, { headers: headers(owner) });
    const ownerSnapshot = (await ownerResponse.json()) as { items: { id: string }[] };
    const memberResponse = await fetch(`${origin}/api/status`, { headers: headers(member) });
    const memberSnapshot = (await memberResponse.json()) as typeof ownerSnapshot;
    observe(
      "dashboard APIs require a browser session and exclude other workspaces and unknown ownership",
      anonymous.status === 401 &&
        ownerSnapshot.items
          .map((item) => item.id)
          .sort()
          .join() === "other-team,own" &&
        memberSnapshot.items.map((item) => item.id).join() === "own",
      {
        anonymous: anonymous.status,
        ownerItems: ownerSnapshot.items.map((item) => item.id),
        memberItems: memberSnapshot.items.map((item) => item.id),
      },
    );
    observe(
      "authenticated dashboard data has no public CORS grant",
      ownerResponse.headers.get("access-control-allow-origin") === null,
      { cors: ownerResponse.headers.get("access-control-allow-origin") },
    );
    const crossWorkspace = await fetch(`${origin}/api/status?workspaceId=another-workspace`, {
      headers: headers(owner),
    });
    const crossWorkspaceMembers = await fetch(
      `${origin}/api/workspaces/members?workspaceId=another-workspace`,
      { headers: headers(owner) },
    );
    observe(
      "a caller cannot switch workspace through request parameters",
      crossWorkspace.status === 403 && crossWorkspaceMembers.status === 403,
      { dashboard: crossWorkspace.status, members: crossWorkspaceMembers.status },
    );
    const conversations = (await (
      await fetch(`${origin}/api/linear/conversations`, { headers: headers(member) })
    ).json()) as { sessions: { id: string }[] };
    observe(
      "conversation reads use the same verified team scope",
      conversations.sessions.map((session) => session.id).join() === "session-own",
      conversations.sessions.map((session) => session.id),
    );
    const ownArtifact = await fetch(`${origin}/api/linear/artifacts/${ids[0]}`, {
      headers: headers(member),
    });
    const foreignArtifact = await fetch(`${origin}/api/linear/artifacts/${ids[1]}`, {
      headers: headers(member),
    });
    observe(
      "foreign artifact IDs are denied before their bytes are read",
      ownArtifact.status === 200 && foreignArtifact.status === 404 && reads.join() === ids[0],
      { own: ownArtifact.status, foreign: foreignArtifact.status, reads },
    );
    const settings = await fetch(`${origin}/api/settings/agents`, { headers: headers(member) });
    const probe = await fetch(`${origin}/api/settings/agents/test`, {
      method: "POST",
      headers: headers(member),
      body: JSON.stringify({ profile: { agent: "claude", model: null } }),
    });
    observe(
      "members cannot read owner settings or invoke host credential probes",
      settings.status === 403 && probe.status === 403 && probes === 0,
      { settings: settings.status, probe: probe.status, invocations: probes },
    );
    const stale = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(oldOwner),
      body: JSON.stringify({ userId: memberId, role: "admin" }),
    });
    observe("workspace role changes require sign-in within fifteen minutes", stale.status === 403, {
      status: stale.status,
    });
    const missingCsrf = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: { cookie: headers(owner).cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ userId: memberId, role: "admin" }),
    });
    const changed = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: memberId, role: "observer" }),
    });
    const lastOwner = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: ownerId, role: "member" }),
    });
    observe(
      "owner administration enforces CSRF and retains an active owner",
      missingCsrf.status === 403 && changed.status === 200 && lastOwner.status === 400,
      { missingCsrf: missingCsrf.status, changed: changed.status, lastOwner: lastOwner.status },
    );
    const unmapped = await fetch(`${origin}/api/workspaces/repositories`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({
        repositories: [{ repository: "fixture/private", teamId: "foreign" }],
      }),
    });
    const mapped = await fetch(`${origin}/api/workspaces/repositories`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ repositories: [{ repository: "fixture/private", teamId: "team-a" }] }),
    });
    const remapped = (await (
      await fetch(`${origin}/api/status`, { headers: headers(owner) })
    ).json()) as typeof ownerSnapshot;
    observe(
      "repository scope changes only after an owner maps a verified Linear team",
      unmapped.status === 400 &&
        mapped.status === 200 &&
        remapped.items
          .map((item) => item.id)
          .sort()
          .join() === "other-team,unmapped-repo",
      {
        rejected: unmapped.status,
        saved: mapped.status,
        items: remapped.items.map((item) => item.id),
      },
    );
    const ownerPage = await fetch(`${origin}/status/`, { headers: headers(owner) });
    const pageCsrf = (await ownerPage.text()).match(/name="paws-csrf" content="([^"]+)"/)?.[1];
    const pageAction = await fetch(`${origin}/api/settings/agents/test`, {
      method: "POST",
      headers: { ...headers(owner), "x-paws-csrf": pageCsrf ?? "" },
      body: JSON.stringify({ profile: { agent: "claude", model: null } }),
    });
    observe(
      "authenticated status HTML supplies the session CSRF accepted by owner host controls",
      pageCsrf === owner.session.csrfToken && pageAction.status === 200 && probes === 1,
      {
        matchingSessionCsrf: pageCsrf === owner.session.csrfToken,
        status: pageAction.status,
        probes,
      },
    );
    const outageSession = issueWorkspaceSession(db, {
      workspaceId: workspace.id,
      userId: ownerId,
      now,
    });
    db.run("UPDATE workspace_member SET checked_at=? WHERE workspace_id=? AND user_id=?", [
      now - 6 * 60_000,
      workspace.id,
      ownerId,
    ]);
    membershipFailure = true;
    const outagePage = await fetch(`${origin}/status/`, { headers: headers(outageSession) });
    const outageCsrf = (await outagePage.text()).match(/name="paws-csrf" content="([^"]+)"/)?.[1];
    const outageData = await fetch(`${origin}/api/status`, { headers: headers(outageSession) });
    const outageLogout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { ...headers(outageSession), "x-paws-csrf": outageCsrf ?? "" },
    });
    membershipFailure = false;
    db.run("UPDATE workspace_member SET checked_at=? WHERE workspace_id=? AND user_id=?", [
      now,
      workspace.id,
      ownerId,
    ]);
    observe(
      "a dashboard reload during a Linear outage supplies logout CSRF while data stays closed",
      outagePage.status === 200 && outageData.status === 503 && outageLogout.status === 200,
      { page: outagePage.status, data: outageData.status, logout: outageLogout.status },
    );
    const enrollment = await fetch(`${origin}/api/runner-pairings`, { method: "POST" });
    const noPrincipal = await fetch(`${origin}/api/runners`);
    const noCsrf = await fetch(`${origin}/api/runners/approve`, {
      method: "POST",
      headers: { cookie: headers(owner).cookie, origin },
    });
    const runner = await fetch(`${origin}/api/runners`, { headers: headers(owner) });
    observe(
      "runner approval receives only a verified principal while enrollment has its own exact route",
      enrollment.status === 202 &&
        enrollments === 1 &&
        noPrincipal.status === 401 &&
        noCsrf.status === 403 &&
        runner.status === 200 &&
        runnerCalls.length === 1 &&
        runnerCalls[0]?.userId === ownerId &&
        runnerCalls[0]?.workspaceId === workspace.id,
      {
        enrollment: enrollment.status,
        anonymous: noPrincipal.status,
        noCsrf: noCsrf.status,
        runner: runner.status,
        runnerCalls,
      },
    );
    guest = true;
    const guestPromotion = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: memberId, role: "admin" }),
    });
    observe(
      "owner role overrides cannot grant steering to a verified Linear guest",
      guestPromotion.status === 400,
      { status: guestPromotion.status },
    );
    memberTeams = [];
    await access.refreshMemberships();
    const refreshed = (await (
      await fetch(`${origin}/api/status`, { headers: headers(member) })
    ).json()) as typeof ownerSnapshot;
    const refreshedSession = (await (
      await fetch(`${origin}/api/auth/session`, { headers: headers(member) })
    ).json()) as { role: string; teamIds: string[] };
    observe(
      "forced membership sync removes team visibility immediately while retaining manual roles",
      refreshed.items.length === 0 &&
        refreshedSession.teamIds.length === 0 &&
        refreshedSession.role === "observer",
      { items: refreshed.items, teamIds: refreshedSession.teamIds, role: refreshedSession.role },
    );
    const invalidRole = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: memberId, role: ["owner"] }),
    });
    const invalidRoleBody = (await invalidRole.json()) as { error: string };
    observe(
      "role settings reject non-string roles before database binding",
      invalidRole.status === 400 && invalidRoleBody.error === "Choose a workspace member and role.",
      { status: invalidRole.status, error: invalidRoleBody.error },
    );
    guest = false;
    await Bun.sleep(2);
    const restoredOverride = await fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: memberId, role: "admin" }),
    });
    await access.refreshMemberships();
    const restoredOverrideSession = (await (
      await fetch(`${origin}/api/auth/session`, { headers: headers(member) })
    ).json()) as { role: string };
    observe(
      "a new manual role replaces the preserved override and survives verified membership sync",
      restoredOverride.status === 200 && restoredOverrideSession.role === "admin",
      { status: restoredOverride.status, role: restoredOverrideSession.role },
    );
    const pendingMembership = Promise.withResolvers<void>();
    const releaseMembership = Promise.withResolvers<void>();
    memberReadBarrier = {
      entered: pendingMembership.resolve,
      wait: releaseMembership.promise,
    };
    const delayedPromotion = fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: memberId, role: "owner" }),
    });
    await pendingMembership.promise;
    guest = true;
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: memberId,
      role: "observer",
      active: true,
      teamIds: [],
      now: Date.now(),
    });
    releaseMembership.resolve();
    const stalePromotion = await delayedPromotion;
    const cappedMember = workspaceMember(db, workspace.id, memberId)!;
    observe(
      "delayed owner promotion cannot lift a newer verified guest cap",
      stalePromotion.status === 400 && cappedMember.role === "observer",
      { status: stalePromotion.status, role: cappedMember.role },
    );
    const ownerReadStarted = Promise.withResolvers<void>();
    const ownerReadRelease = Promise.withResolvers<void>();
    memberReadBarrier = { entered: ownerReadStarted.resolve, wait: ownerReadRelease.promise };
    guest = false;
    const beforeDemotion = workspaceMember(db, workspace.id, memberId)!;
    await Bun.sleep(2);
    const demotedWrite = fetch(`${origin}/api/workspaces/members`, {
      method: "PUT",
      headers: headers(owner),
      body: JSON.stringify({ userId: memberId, role: "admin" }),
    });
    await ownerReadStarted.promise;
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: ownerId,
      active: true,
      role: "observer",
      teamIds: [],
      now: Date.now() + 1,
    });
    ownerReadRelease.resolve();
    const deniedOwner = await demotedWrite;
    const afterDemotion = workspaceMember(db, workspace.id, memberId)!;
    observe(
      "an owner demoted during membership lookup cannot mutate the target membership",
      deniedOwner.status === 400 &&
        afterDemotion.checkedAt === beforeDemotion.checkedAt &&
        afterDemotion.role === beforeDemotion.role &&
        afterDemotion.teamIds.join() === beforeDemotion.teamIds.join(),
      {
        status: deniedOwner.status,
        before: beforeDemotion.checkedAt,
        after: afterDemotion.checkedAt,
      },
    );
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: ownerId,
      active: true,
      role: "member",
      teamIds: ["team-a"],
      now: Date.now() + 2,
    });
    changeLinearTeamAccess(db, {
      eventKey: "fixture-team-removal",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      createdAtMs: now + 1,
      canAccessAllPublicTeams: true,
      addedTeamIds: [],
      removedTeamIds: ["team-a"],
    });
    const withdrawn = (await (
      await fetch(`${origin}/api/status`, { headers: headers(owner) })
    ).json()) as typeof ownerSnapshot;
    observe(
      "verified app team access removal hides its historical data even from workspace owners",
      withdrawn.items.map((item) => item.id).join() === "other-team",
      { items: withdrawn.items.map((item) => item.id) },
    );
  } finally {
    writeFileSync(
      join(root, "audit.json"),
      JSON.stringify(db.query("SELECT * FROM workspace_access_audit").all(), null, 2),
    );
    await server.stop(true);
    db.close();
  }
}
