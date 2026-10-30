import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  workspaceMember,
} from "../../src/db";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  requestWorkspaceSession,
  workspaceId,
  workspaceSessionCookie,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../../src/workspace";

export async function probeWorkspaceAccess(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const path = join(root, "workspace.sqlite");
  const db = openDatabase(path);
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(now),
    linearUserId: "linear-owner",
    name: "Fixture owner",
    email: "owner@example.invalid",
  });
  const workspace = {
    id: workspaceId(now),
    organizationId: "verified-linear-org",
    name: "Fixture workspace",
  };
  const grant = issueWorkspaceBootstrap(db, workspace.organizationId, now);
  let mismatchRejected = false;
  try {
    consumeWorkspaceBootstrap(db, {
      ...workspace,
      organizationId: "unrelated-org",
      tokenHash: workspaceTokenHash(grant),
      userId,
      now,
    });
  } catch {
    mismatchRejected = true;
  }
  consumeWorkspaceBootstrap(db, {
    ...workspace,
    tokenHash: workspaceTokenHash(grant),
    userId,
    now,
  });
  let replayError = "";
  try {
    consumeWorkspaceBootstrap(db, {
      ...workspace,
      tokenHash: workspaceTokenHash(grant),
      userId,
      now,
    });
  } catch (error) {
    replayError = error instanceof Error ? error.message : String(error);
  }
  observe(
    "workspace bootstrap requires its verified organization and is single-use",
    mismatchRejected && replayError === "Workspace bootstrap is invalid or expired.",
    {
      mismatchRejected,
      replayError,
    },
  );
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId,
    role: "member",
    active: true,
    teamIds: ["team-one"],
    now: now + 1,
  });
  const member = workspaceMember(db, workspace.id, userId);
  observe(
    "Linear membership sync preserves the manual owner and its verified teams",
    member?.role === "admin" && member.teamIds.join() === "team-one",
    member,
  );
  const issued = issueWorkspaceSession(db, { userId, workspaceId: workspace.id, now });
  const cookie = `${WORKSPACE_COOKIE}=${issued.token}`;
  const request = new Request("https://paws.example.invalid/api/status", { headers: { cookie } });
  const stored = JSON.stringify(db.query("SELECT * FROM workspace_session").all());
  observe(
    "browser session is stored as a hash and uses secure cookie attributes",
    !stored.includes(issued.token) &&
      ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"].every((part) =>
        workspaceSessionCookie(issued.token).includes(part),
      ),
    {
      plaintextTokenStored: stored.includes(issued.token),
      cookieAttributes: workspaceSessionCookie("redacted").split(";").slice(1),
    },
  );
  const fixture = resolve(import.meta.dir, "../fixtures/workspace-session-server.ts");
  db.close();
  const responses: unknown[] = [];
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawn([process.execPath, "--no-env-file", fixture, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let text = "";
    try {
      while (!text.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error("Workspace fixture stopped before listening.");
        text += new TextDecoder().decode(next.value);
      }
      const { origin } = JSON.parse(text.split("\n")[0]!) as { origin: string };
      const anonymous = await fetch(origin);
      const response = await fetch(origin, { headers: { cookie } });
      const principal = await response.json();
      responses.push({
        pid: child.pid,
        status: response.status,
        anonymous: anonymous.status,
        principal,
      });
    } finally {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      await child.exited;
      reader.releaseLock();
    }
  }
  const expected = JSON.stringify({
    workspaceId: workspace.id,
    userId,
    role: "admin",
    teamIds: ["team-one"],
    authenticatedAt: now,
  });
  observe(
    "owned HTTP subprocess restart preserves session identity and ownership",
    responses.every((raw) => {
      const value = raw as { status: number; anonymous: number; principal: unknown };
      return (
        value.status === 200 &&
        value.anonymous === 401 &&
        JSON.stringify(value.principal) === expected
      );
    }),
    responses,
  );
  const restored = openDatabase(path);
  const idle = issueWorkspaceSession(restored, { userId, workspaceId: workspace.id, now });
  const idleRequest = new Request(request.url, {
    headers: { cookie: `${WORKSPACE_COOKIE}=${idle.token}` },
  });
  const day = 24 * 60 * 60_000;
  const liveBeforeIdleLimit =
    requestWorkspaceSession(restored, idleRequest, now + 30 * day - 1) !== null;
  const extendedByUse = requestWorkspaceSession(restored, idleRequest, now + 59 * day) !== null;
  const idleExpiry = requestWorkspaceSession(restored, idleRequest, now + 90 * day) === null;
  observe(
    "browser sessions extend on each use and expire after thirty idle days",
    liveBeforeIdleLimit && extendedByUse && idleExpiry,
    { liveBeforeIdleLimit, extendedByUse, idleExpiry },
  );
  syncWorkspaceMember(restored, {
    workspaceId: workspace.id,
    userId,
    role: "member",
    active: false,
    teamIds: [],
    now: now + 2,
  });
  observe(
    "membership removal invalidates an existing browser session",
    requestWorkspaceSession(restored, request, now + 2) === null,
    {
      member: workspaceMember(restored, workspace.id, userId),
      remainingSessions: restored.query("SELECT count(*) AS count FROM workspace_session").get(),
    },
  );
  const audits = restored
    .query<{ count: number }, []>("SELECT count(*) AS count FROM workspace_access_audit")
    .get()!.count;
  syncWorkspaceMember(restored, {
    workspaceId: workspace.id,
    userId,
    role: "member",
    active: false,
    teamIds: ["stale-team"],
    now: now + 3,
  });
  syncWorkspaceMember(restored, {
    workspaceId: workspace.id,
    userId,
    role: "member",
    active: true,
    teamIds: ["stale-team"],
    now: now + 3,
  });
  const tied = workspaceMember(restored, workspace.id, userId);
  observe(
    "same-timestamp active observation cannot restore revoked membership or teams",
    tied?.active === false && tied.teamIds.length === 0,
    tied,
  );
  const repeatedAudits = restored
    .query<{ count: number }, []>("SELECT count(*) AS count FROM workspace_access_audit")
    .get()!.count;
  observe(
    "repeated membership revocation preserves an idempotent audit",
    audits === repeatedAudits,
    { audits, repeatedAudits },
  );
  syncWorkspaceMember(restored, {
    workspaceId: workspace.id,
    userId,
    role: "member",
    active: true,
    teamIds: ["team-one"],
    now: now + 4,
  });
  const returned = issueWorkspaceSession(restored, {
    userId,
    workspaceId: workspace.id,
    now: now + 4,
  });
  const returnedRequest = new Request(request.url, {
    headers: { cookie: `${WORKSPACE_COOKIE}=${returned.token}` },
  });
  const returnedPrincipal = requestWorkspaceSession(restored, returnedRequest, now + 4)?.principal;
  observe(
    "verified membership restoration retains the manually granted owner role",
    returnedPrincipal?.role === "admin" &&
      requestWorkspaceSession(restored, request, now + 4) === null,
    {
      role: returnedPrincipal?.role,
      oldSessionRevoked: requestWorkspaceSession(restored, request, now + 4) === null,
    },
  );
  let liveWhileUsed = true;
  for (let days = 20; days <= 120; days += 20)
    liveWhileUsed &&=
      requestWorkspaceSession(restored, returnedRequest, now + 4 + days * day) !== null;
  observe("regularly used browser sessions stay signed in beyond thirty days", liveWhileUsed, {
    liveWhileUsed,
  });
  writeFileSync(
    join(root, "audit.json"),
    JSON.stringify(restored.query("SELECT * FROM workspace_access_audit").all(), null, 2),
  );
  restored.close();
}
