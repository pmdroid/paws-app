import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  workspaceMember,
} from "../../src/db";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  startWorkspaceAccess,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";

type Observe = (name: string, passed: boolean, observed: unknown) => void;

export async function probeWorkspaceRefresh(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "lifecycle.sqlite"));
  migrate(db);
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Workspace",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org")),
    now: Date.now(),
  });
  let reads = 0;
  let errors = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  const secondGate = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const sessionBeforeRefresh = issueWorkspaceSession(db, {
    userId,
    workspaceId: workspace.id,
    now: Date.now(),
  });
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const runtime = startWorkspaceAccess({
    db,
    publicUrl: "https://paws.example",
    clientId: "client",
    refreshIntervalMs: 50,
    onError: () => errors++,
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, linearUserId) {
        const read = ++reads;
        maxActiveReads = Math.max(maxActiveReads, ++activeReads);
        if (read === 1) {
          started.resolve();
          await gate.promise;
        } else {
          secondStarted.resolve();
          await secondGate.promise;
        }
        activeReads--;
        return {
          organizationId,
          userId: linearUserId,
          active: read === 1,
          guest: false,
          admin: false,
          teamIds: [],
        };
      },
    },
  });
  const keepAlive = setTimeout(() => {}, 1000);
  await started.promise;
  clearTimeout(keepAlive);
  const sameOperation = runtime.refresh() === runtime.refresh();
  gate.resolve();
  await Promise.race([secondStarted.promise, Bun.sleep(20)]);
  const access = await runtime.access;
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  const rejectedBeforeDrain = [false, false, false];
  const request = new Request("https://paws.example/api/auth/session", {
    headers: { cookie: `${WORKSPACE_COOKIE}=${sessionBeforeRefresh.token}` },
  });
  const attempts = [
    access.authenticate(request),
    access.handle(request),
    access.refreshMemberships(),
  ].map((operation, index) =>
    operation.catch(() => {
      rejectedBeforeDrain[index] = true;
    }),
  );
  await Bun.sleep(5);
  const waited = !stopped;
  const rejectedDuringDrain = rejectedBeforeDrain.every(Boolean);
  secondGate.resolve();
  await Promise.all([stopping, ...attempts]);
  const member = workspaceMember(db, workspace.id, userId);
  await runtime.refresh();
  observe(
    "permission invalidations during a refresh coalesce into a nonoverlapping follow-up joined by shutdown",
    sameOperation &&
      reads === 2 &&
      maxActiveReads === 1 &&
      waited &&
      stopped &&
      member?.active === false &&
      errors === 0,
    { sameOperation, reads, maxActiveReads, waited, stopped, active: member?.active, errors },
  );
  observe(
    "shutdown rejects new browser and membership operations while draining accepted passes",
    rejectedDuringDrain,
    { rejectedBeforeDrain },
  );
  const remainingSession = db
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM workspace_session WHERE token_hash=?",
    )
    .get(sessionBeforeRefresh.session.tokenHash)!.count;
  observe(
    "the later revocation deletes a persistent session after an earlier active snapshot",
    remainingSession === 0,
    { remainingSession },
  );
  let rejected = false;
  try {
    await access.handle(new Request("https://paws.example/api/auth/session"));
  } catch {
    rejected = true;
  }
  observe("closed workspace access rejects new async operations", rejected, rejected);
  db.close();

  const draining = openDatabase(join(root, "request-drain.sqlite"));
  migrate(draining);
  const memberId = putWorkspaceUser(draining, {
    id: workspaceId(),
    linearUserId: "request-member",
    name: "Member",
    email: "member@example.invalid",
  });
  const selected = consumeWorkspaceBootstrap(draining, {
    id: workspaceId(),
    organizationId: "org",
    name: "Workspace",
    userId: memberId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(draining, "org", 0)),
    now: 0,
  });
  const session = issueWorkspaceSession(draining, {
    userId: memberId,
    workspaceId: selected.id,
    now: Date.now(),
  });
  const requestGate = Promise.withResolvers<void>();
  const requestStarted = Promise.withResolvers<void>();
  let requestReads = 0;
  const owner = startWorkspaceAccess({
    db: draining,
    publicUrl: "https://paws.example",
    clientId: "client",
    onError: () => errors++,
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, linearUserId) {
        const read = ++requestReads;
        requestStarted.resolve();
        if (read === 1) await requestGate.promise;
        return {
          organizationId,
          userId: linearUserId,
          active: read === 1,
          guest: false,
          admin: false,
          teamIds: [],
        };
      },
    },
  });
  const ready = await owner.access;
  const authenticated = ready.authenticate(
    new Request("https://paws.example/api/status", {
      headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}` },
    }),
  );
  await requestStarted.promise;
  const forcedRefresh = owner.refresh();
  let requestStopped = false;
  const stop = owner.stop().then(() => {
    requestStopped = true;
  });
  await Bun.sleep(5);
  const requestWaited = !requestStopped;
  requestGate.resolve();
  await authenticated;
  await forcedRefresh;
  await stop;
  const current = workspaceMember(draining, selected.id, memberId);
  observe(
    "shutdown joins the HTTP lookup and a fresh forced read after a later invalidation",
    requestWaited && requestStopped && requestReads === 2 && current?.active === false,
    { requestWaited, requestStopped, requestReads, active: current?.active },
  );
  let boundaryReads = 0;
  const boundary = startWorkspaceAccess({
    db: draining,
    publicUrl: "https://paws.example",
    clientId: "client",
    onError: () => errors++,
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, linearUserId) {
        boundaryReads++;
        return {
          organizationId,
          userId: linearUserId,
          active: false,
          guest: false,
          admin: false,
          teamIds: [],
        };
      },
    },
  });
  const boundaryAccess = await boundary.access;
  const originalRefresh = boundaryAccess.refreshMemberships;
  let passes = 0;
  let late: Promise<void> | undefined;
  boundaryAccess.refreshMemberships = () =>
    originalRefresh().then(() => {
      if (++passes === 1)
        queueMicrotask(() =>
          queueMicrotask(() => {
            late = boundary.refresh();
          }),
        );
    });
  const initial = boundary.refresh();
  await initial;
  await late;
  await boundary.stop();
  observe(
    "an invalidation at refresh completion starts a new joined pass",
    boundaryReads === 2 && late !== undefined && late !== initial,
    { boundaryReads, newOperation: late !== initial },
  );
  draining.close();
}
