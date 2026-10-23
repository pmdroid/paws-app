import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  MEMBERSHIP_BACKSTOP_MS,
  migrate,
  openDatabase,
  syncWorkspaceMember,
  workspaceForOrganization,
  workspaceMember,
} from "../../src/db";
import { createLinearMembershipReads } from "../../src/linear";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  WORKSPACE_COOKIE,
  type WorkspaceAccess,
  type WorkspaceAccessOptions,
  workspaceTokenHash,
} from "../../src/workspace";

export async function probeWorkspaceBrowser(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "browser.sqlite"));
  migrate(db);
  let now = Date.now();
  let active = true;
  let guest = false;
  let membershipFailure = false;
  const requests: unknown[] = [];
  const membershipReads = createLinearMembershipReads({
    async query(query, variables) {
      requests.push({ query, variables });
      if (membershipFailure) throw new Error("Linear unavailable");
      const cursor = variables?.["after"];
      return {
        viewer: { app: true, organization: { id: "org" } },
        user: {
          id: variables?.["id"],
          active,
          guest,
          admin: false,
          organization: { id: "org" },
          teams: {
            nodes: [{ id: cursor === null ? "team-a" : "team-b" }],
            pageInfo: { hasNextPage: cursor === null, endCursor: cursor === null ? "next" : null },
          },
        },
      };
    },
  });
  let membershipBarrier: { entered: () => void; wait: Promise<void> } | undefined;
  let membershipDelayMs = 0;
  const memberships = {
    ...membershipReads,
    async member(...args: Parameters<typeof membershipReads.member>) {
      const identity = await membershipReads.member(...args);
      now += membershipDelayMs;
      membershipDelayMs = 0;
      const barrier = membershipBarrier;
      if (barrier !== undefined) {
        membershipBarrier = undefined;
        barrier.entered();
        await barrier.wait;
      }
      return identity;
    },
  };
  let access: WorkspaceAccess | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return (await access?.handle(request)) ?? new Response("Not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const accessOptions: WorkspaceAccessOptions = {
    db,
    publicUrl: origin,
    clientId: "fixture-client",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships,
    now: () => now,
    fetch: (async (input, init) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        const body = new URLSearchParams(String(init?.body));
        requests.push({ tokenRequest: Object.fromEntries(body) });
        return Response.json({
          access_token: `fixture-token-${body.get("code")}`,
          refresh_token: "discard-this-fixture-token",
        });
      }
      if (url !== "https://api.linear.app/graphql") throw new Error("Unexpected hosted request");
      const token = new Headers(init?.headers).get("authorization") ?? "";
      const user = token.endsWith("owner")
        ? "owner"
        : token.endsWith("outsider")
          ? "outsider"
          : "member";
      return Response.json({
        data: {
          viewer: {
            id: user,
            name: user,
            email: `${user}@example.invalid`,
            app: false,
            organization: { id: user === "outsider" ? "other-org" : "org", name: "Workspace" },
          },
        },
      });
    }) as typeof fetch,
  };
  access = createWorkspaceAccess(accessOptions);
  async function login(user: string, bootstrap?: string) {
    const start = await fetch(
      `${origin}/auth/linear`,
      bootstrap === undefined
        ? { redirect: "manual" }
        : {
            method: "POST",
            redirect: "manual",
            headers: { origin, "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ bootstrap }),
          },
    );
    const target = new URL(start.headers.get("location")!);
    const loginCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = `${origin}/auth/linear/callback?state=${target.searchParams.get("state")}&code=${user}`;
    const wrongBrowser = await fetch(callback, {
      redirect: "manual",
      headers: { cookie: `__Host-paws-login=${"x".repeat(43)}` },
    });
    const response = await fetch(callback, {
      redirect: "manual",
      headers: { cookie: loginCookie },
    });
    const cookie = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${WORKSPACE_COOKIE}=`))
      ?.split(";")[0];
    return { target, callback, loginCookie, response, cookie, wrongBrowser };
  }
  try {
    const withoutBootstrap = await login("owner");
    observe(
      "first Linear visitor cannot claim workspace ownership",
      withoutBootstrap.response.status === 403 && workspaceForOrganization(db, "org") === null,
      { status: withoutBootstrap.response.status },
    );
    membershipDelayMs = 1000;
    const owner = await login("owner", issueWorkspaceBootstrap(db, "org", now));
    const member = await login("member");
    const outsider = await login("outsider");
    const ownerSession = (await (
      await fetch(`${origin}/api/auth/session`, { headers: { cookie: owner.cookie! } })
    ).json()) as {
      userId: string;
      workspaceId: string;
      role: string;
      teamIds: string[];
      csrfToken: string;
    };
    const memberSession = (await (
      await fetch(`${origin}/api/auth/session`, { headers: { cookie: member.cookie! } })
    ).json()) as typeof ownerSession;
    observe(
      "operator bootstrap preserves verified owner teams after an advancing-clock membership read",
      ownerSession.teamIds.join() === "team-a,team-b",
      ownerSession.teamIds,
    );
    observe(
      "two Linear users sign in with separate identities in one workspace",
      owner.response.status === 303 &&
        member.response.status === 303 &&
        ownerSession.userId !== memberSession.userId &&
        ownerSession.workspaceId === memberSession.workspaceId &&
        ownerSession.role === "owner" &&
        memberSession.role === "member",
      {
        owner: { ...ownerSession, csrfToken: "redacted" },
        member: { ...memberSession, csrfToken: "redacted" },
      },
    );
    observe(
      "browser OAuth uses user actor, read scope and PKCE",
      owner.target.searchParams.get("actor") === "user" &&
        owner.target.searchParams.get("scope") === "read" &&
        owner.target.searchParams.get("code_challenge_method") === "S256" &&
        owner.target.searchParams.get("code_challenge") ===
          createHash("sha256")
            .update(
              (
                requests.findLast(
                  (entry) =>
                    typeof entry === "object" &&
                    entry !== null &&
                    "tokenRequest" in entry &&
                    (entry.tokenRequest as Record<string, string>)["code"] === "owner",
                ) as { tokenRequest: Record<string, string> }
              ).tokenRequest["code_verifier"]!,
            )
            .digest("base64url"),
      {
        actor: owner.target.searchParams.get("actor"),
        scope: owner.target.searchParams.get("scope"),
        challenge: owner.target.searchParams.get("code_challenge_method"),
      },
    );
    observe(
      "OAuth callback state is bound to the browser that began sign-in",
      [owner, member, outsider].every((attempt) => attempt.wrongBrowser.status === 400) &&
        owner.response.status === 303 &&
        member.response.status === 303,
      { wrongBrowser: [owner, member, outsider].map((attempt) => attempt.wrongBrowser.status) },
    );
    observe(
      "another Linear organization receives no Paws session",
      outsider.response.status === 403 && outsider.cookie === undefined,
      { status: outsider.response.status },
    );
    observe(
      "verified membership includes teams beyond the first page",
      memberSession.teamIds.join() === "team-a,team-b",
      memberSession.teamIds,
    );
    const replay = await fetch(owner.callback, {
      redirect: "manual",
      headers: { cookie: owner.loginCookie },
    });
    observe("OAuth callback replay is rejected", replay.status === 400, { status: replay.status });
    const pendingStart = await fetch(`${origin}/auth/linear`, { redirect: "manual" });
    const pendingTarget = new URL(pendingStart.headers.get("location")!);
    const pendingCookie = pendingStart.headers.get("set-cookie")!.split(";")[0]!;
    const pendingState = pendingTarget.searchParams.get("state")!;
    const pendingRow = db
      .query<{ verifier: string }, [string]>(
        "SELECT verifier FROM workspace_oauth_request WHERE state_hash = ?",
      )
      .get(workspaceTokenHash(pendingState));
    access = createWorkspaceAccess(accessOptions);
    const resumed = await fetch(`${origin}/auth/linear/callback?state=${pendingState}&code=owner`, {
      redirect: "manual",
      headers: { cookie: pendingCookie },
    });
    const resumedToken = requests.findLast(
      (entry) => typeof entry === "object" && entry !== null && "tokenRequest" in entry,
    ) as { tokenRequest: Record<string, string> };
    observe(
      "pending OAuth survives handler reconstruction without storing a PKCE verifier",
      pendingRow?.verifier === "" &&
        resumed.status === 303 &&
        pendingTarget.searchParams.get("code_challenge") ===
          createHash("sha256")
            .update(resumedToken.tokenRequest["code_verifier"]!)
            .digest("base64url"),
      { storedVerifier: pendingRow?.verifier, status: resumed.status },
    );
    now += MEMBERSHIP_BACKSTOP_MS;
    membershipFailure = true;
    const csrfRejected = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: owner.cookie!, origin },
    });
    observe("session changes require the browser session CSRF token", csrfRejected.status === 403, {
      status: csrfRejected.status,
    });
    const loggedOut = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: owner.cookie!, origin, "x-paws-csrf": ownerSession.csrfToken },
    });
    const oldCookie = await fetch(`${origin}/api/auth/session`, {
      headers: { cookie: owner.cookie! },
    });
    observe(
      "sign-out invalidates the existing session cookie during a Linear outage",
      loggedOut.status === 200 && oldCookie.status === 401,
      { logout: loggedOut.status, oldCookie: oldCookie.status },
    );
    membershipFailure = false;
    guest = true;
    now += 1;
    const guestLogin = await login("owner");
    const guestMember = workspaceMember(db, ownerSession.workspaceId, ownerSession.userId);
    const preservedRole = db
      .query<{ manual_role: string }, [string, string]>(
        "SELECT manual_role FROM workspace_member WHERE workspace_id=? AND user_id=?",
      )
      .get(ownerSession.workspaceId, ownerSession.userId)?.manual_role;
    syncWorkspaceMember(db, {
      workspaceId: ownerSession.workspaceId,
      userId: ownerSession.userId,
      role: "member",
      active: true,
      teamIds: ["team-a", "team-b"],
      now,
    });
    const tiedGuest = workspaceMember(db, ownerSession.workspaceId, ownerSession.userId);
    observe(
      "equal-time non-guest observation cannot lift an existing observer cap",
      tiedGuest?.role === "observer",
      { role: tiedGuest?.role },
    );
    guest = false;
    now += 1;
    const restoredLogin = await login("owner");
    const restoredMember = workspaceMember(db, ownerSession.workspaceId, ownerSession.userId);
    observe(
      "Linear guest access caps a manual owner to observer and preserves the override for verified restoration",
      guestLogin.response.status === 303 &&
        guestMember?.role === "observer" &&
        preservedRole === "owner" &&
        restoredLogin.response.status === 303 &&
        restoredMember?.role === "owner",
      { guestRole: guestMember?.role, preservedRole, restoredRole: restoredMember?.role },
    );
    active = false;
    now += MEMBERSHIP_BACKSTOP_MS;
    const removed = await fetch(`${origin}/api/auth/session`, {
      headers: { cookie: member.cookie! },
    });
    observe(
      "membership removal is enforced at the next request after the backstop",
      removed.status === 401,
      { status: removed.status },
    );
    active = true;
    let releaseMembership!: () => void;
    let membershipEntered!: () => void;
    const membershipStarted = new Promise<void>((resolve) => {
      membershipEntered = resolve;
    });
    membershipBarrier = {
      entered: membershipEntered,
      wait: new Promise<void>((resolve) => {
        releaseMembership = resolve;
      }),
    };
    const racedLogin = login("owner");
    await membershipStarted;
    now += 1;
    syncWorkspaceMember(db, {
      workspaceId: ownerSession.workspaceId,
      userId: ownerSession.userId,
      role: "member",
      active: false,
      teamIds: [],
      now,
    });
    now += 1;
    releaseMembership();
    const raced = await racedLogin;
    const racedMember = workspaceMember(db, ownerSession.workspaceId, ownerSession.userId);
    observe(
      "membership removal during browser sign-in cannot be undone by a delayed active response",
      raced.response.status === 400 && raced.cookie === undefined && racedMember?.active === false,
      { status: raced.response.status, active: racedMember?.active },
    );
    const persisted =
      JSON.stringify(db.query("SELECT * FROM workspace_session").all()) +
      JSON.stringify(db.query("SELECT * FROM workspace_oauth_request").all());
    observe(
      "Linear browser tokens are discarded after identity verification",
      !persisted.includes("fixture-token") && !persisted.includes("discard-this-fixture-token"),
      { storedHostedToken: persisted.includes("fixture-token") },
    );
  } finally {
    writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2));
    writeFileSync(
      join(root, "audit.json"),
      JSON.stringify(db.query("SELECT * FROM workspace_access_audit").all(), null, 2),
    );
    await server.stop(true);
    db.close();
  }
}
