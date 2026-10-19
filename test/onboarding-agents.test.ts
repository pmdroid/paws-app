import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createRunnerLogin } from "../src/runner-login";
import { createRunnerWork } from "../src/runner-work";
import {
  advanceLinearSessionGeneration,
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import {
  createWorkspaceAccess,
  createWorkspaceAssignments,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";

test("assignment agent sign-in stays private and requires both personal agents on the chosen VM", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-onboarding-vm-"));
  const path = join(root, "paws.sqlite");
  let db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  for (const id of ["owner", "member", "other"])
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const id of ["member", "other"])
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  const installation = {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  };
  const spec = {
    linearIssueId: "issue",
    identifier: "PAS-340",
    title: "Select VM",
    description: "Fixture",
    subIssues: [],
  };
  ensureLinearSession(db, { sessionId: "session", issueId: "issue", creatorId: "member" });
  recordLinearInstallation(db, installation);
  const insertAssignment = (generation: number) =>
    db.run("INSERT INTO workspace_assignment VALUES(?,?,?,?,?,?,?,?,?)", [
      "session",
      generation,
      "workspace",
      "member",
      workspaceTokenHash(String(generation)),
      JSON.stringify({ installation, spec }),
      "{}",
      now + 600000,
      "ready",
    ]);
  insertAssignment(0);
  const sessions = Object.fromEntries(
    ["member", "other", "owner"].map((userId) => [
      userId,
      issueWorkspaceSession(db, { workspaceId: "workspace", userId, now }),
    ]),
  );
  const memberships = {
    async installation() {
      return { id: "org", name: "Workspace" };
    },
    async member(organizationId: string, userId: string) {
      const member = db
        .query<{ role: string; active: number }, [string]>(
          "SELECT role,active FROM workspace_member WHERE workspace_id='workspace' AND user_id=?",
        )
        .get(userId)!;
      return {
        organizationId,
        userId,
        active: member.active === 1,
        guest: member.role === "observer",
        admin: false,
        teamIds: ["team"],
      };
    },
  };
  const buildAssignments = (enabled = true) =>
    createWorkspaceAssignments({
      db,
      ...(enabled ? { onboarding: {} } : {}),
      origin: "https://paws.example.invalid",
      clientId: "client",
      memberships,
      tracker: createFakeTracker([spec]),
      lifecycle: {
        async inspect() {
          throw new Error("No dispatch");
        },
        async startCodeIssue() {
          throw new Error("No credentials");
        },
      },
      async accept() {
        throw new Error("No dispatch");
      },
      async continue() {
        throw new Error("No continuation");
      },
      now: () => now,
    });
  let assignments = buildAssignments();
  let access: ReturnType<typeof createWorkspaceAccess>;
  let authenticatedBody: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      if (authenticatedBody) {
        await access.authenticate(request);
        const beforeBody = authenticatedBody;
        authenticatedBody = undefined;
        beforeBody();
      }
      return (await access.handle(request)) ?? new Response(null, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const commands: string[] = [];
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const login = createRunnerLogin({ db, work, now: () => now });
  let configured = true;
  let beforePrivate: (() => void) | undefined;
  const healthStates = new Map<string, string>();
  const buildAccess = () =>
    createWorkspaceAccess({
      db,
      assignments,
      onboardingAgents: () =>
        configured
          ? {
              login: {
                ...login,
                browser(request, principal, authorize) {
                  const action = beforePrivate;
                  beforePrivate = undefined;
                  action?.();
                  return login.browser(request, principal, authorize);
                },
              },
              health: {
                agents: () =>
                  (["claude", "codex"] as const).map((agent) => ({
                    agent,
                    status: (healthStates.get(agent) ?? "unknown") as
                      | "signed_in"
                      | "signed_out"
                      | "unknown",
                    checkedAt: now,
                  })),
              },
            }
          : undefined,
      publicUrl: origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Workspace" },
      memberships,
      now: () => now,
    });
  access = buildAccess();
  const headers = (user = "member") => ({
    cookie: `${WORKSPACE_COOKIE}=${sessions[user]!.token}`,
    origin,
    "x-paws-csrf": sessions[user]!.session.csrfToken,
    "content-type": "application/json",
  });
  const endpoint = "/api/workspaces/onboarding/agents";
  const get = async (suffix = "", user = "member", generation = 0, runner = runnerId) =>
    fetch(
      `${origin}${endpoint}${suffix}?session=session&generation=${generation}${suffix ? `&runnerId=${runner}` : ""}`,
      { headers: headers(user) },
    );
  const send = (suffix: string, extra = {}, user = "member", method = "POST", override = {}) =>
    fetch(`${origin}${endpoint}${suffix}`, {
      method,
      headers: { ...headers(user), ...override },
      body: JSON.stringify({ session: "session", generation: 0, runnerId, ...extra }),
    });
  const runnerId = workspaceId();
  const addRunner = (id: string, owner = "member") => {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
      [id, "workspace", owner, id, now],
    );
    db.run(
      "INSERT INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until) VALUES(?,?,?,?,?,?,?)",
      [id, id, id, "fixture", now - 1, now + 600000, now + 600000],
    );
  };
  type Reply = {
    id: string;
    state: string;
    ready: boolean;
    terminal: string;
    authorization: { message: string };
  };
  const json = async (response: Response) => response.json() as Promise<Reply>;
  try {
    expect((await json(await get())).ready).toBe(false);
    addRunner(runnerId);
    expect((await get("", "other")).status).toBe(404);
    expect((await get("", "owner")).status).toBe(404);
    expect(
      (await send("/claude/login", {}, "member", "POST", { "x-paws-csrf": "wrong" })).status,
    ).toBe(403);
    expect((await send("/claude/login", { ownerUserId: "owner" })).status).toBe(400);
    configured = false;
    expect((await get()).status).toBe(503);
    configured = true;
    const claude = await json(await send("/claude/login"));
    expect(claude.state).toBe("starting");
    const inputId = randomUUID();
    login.exchange(runnerId, claude.id, {
      state: "waiting",
      terminal: "PRIVATE CLAUDE CODE",
      authorization: null,
      inputId,
    });
    const broad = await (await get()).text();
    expect(broad).not.toContain("PRIVATE");
    expect(broad).not.toContain(claude.id);
    ensureLinearSession(db, { sessionId: "sibling", issueId: "issue", creatorId: "member" });
    recordLinearInstallation(db, { ...installation, sessionId: "sibling" });
    db.run("INSERT INTO workspace_assignment VALUES(?,?,?,?,?,?,?,?,?)", [
      "sibling",
      0,
      "workspace",
      "member",
      workspaceTokenHash("sibling"),
      JSON.stringify({ installation, spec }),
      "{}",
      now + 600000,
      "ready",
    ]);
    const siblingQuery = `?session=sibling&generation=0&runnerId=${runnerId}`;
    expect(
      (
        await fetch(`${origin}${endpoint}/claude/login/${claude.id}${siblingQuery}`, {
          headers: headers(),
        })
      ).status,
    ).toBe(404);
    expect((await send("/claude/login", { session: "sibling" })).status).toBe(409);
    const privateRead = await get(`/claude/login/${claude.id}`);
    expect((await json(privateRead)).terminal).toBe("PRIVATE CLAUDE CODE");
    expect((await get(`/claude/login/${claude.id}`, "other")).status).toBe(404);
    expect(
      (await send(`/claude/login/${claude.id}/input`, { input: { text: "private answer" } }))
        .status,
    ).toBe(200);
    beforePrivate = () =>
      db.run("UPDATE linear_session SET stopped_at=? WHERE session_id='session'", [now]);
    expect(
      (await send(`/claude/login/${claude.id}/input`, { input: { text: "raced answer" } })).status,
    ).toBe(403);
    db.run("UPDATE linear_session SET stopped_at=NULL WHERE session_id='session'");
    const reply = login.exchange(runnerId, claude.id, {
      state: "waiting",
      terminal: "",
      authorization: null,
      inputId,
    });
    expect(reply.input?.value).toEqual({ text: "private answer" });
    login.exchange(runnerId, claude.id, {
      state: "connected",
      terminal: "",
      authorization: null,
      inputId: null,
    });
    healthStates.set("claude", "signed_in");
    expect((await json(await get())).ready).toBe(false);
    const before = db.query("SELECT count(*) AS count FROM runner_command").get();
    expect((await json(await send("/claude/login"))).state).toBe("connected");
    expect(db.query("SELECT count(*) AS count FROM runner_command").get()).toEqual(before);
    const codex = await json(await send("/codex/login"));
    login.exchange(runnerId, codex.id, {
      state: "waiting",
      terminal: "",
      authorization: {
        url: "https://auth.openai.com/codex/device",
        message: "PRIVATE DEVICE CODE",
      },
      inputId: randomUUID(),
    });
    expect(await (await get()).text()).not.toContain("PRIVATE");
    expect((await json(await get(`/codex/login/${codex.id}`))).authorization.message).toBe(
      "PRIVATE DEVICE CODE",
    );
    expect((await send(`/codex/login/${codex.id}`, {}, "member", "DELETE")).status).toBe(200);
    const failed = await json(await send("/codex/login"));
    expect(failed.id).not.toBe(codex.id);
    login.exchange(runnerId, failed.id, {
      state: "failed",
      terminal: "secret failure",
      authorization: null,
      inputId: null,
    });
    expect(await (await get()).text()).toContain("failed");
    const expired = await json(await send("/codex/login"));
    now += 600001;
    db.run("UPDATE runner_certificate SET accepted_until=?,not_after=?", [
      now + 600000,
      now + 600000,
    ]);
    expect(await (await get()).text()).toContain("expired");
    const retry = await json(await send("/codex/login"));
    expect(retry.id).not.toBe(expired.id);
    login.exchange(runnerId, retry.id, {
      state: "connected",
      terminal: "",
      authorization: null,
      inputId: null,
    });
    healthStates.set("codex", "signed_in");
    expect((await json(await get())).ready).toBe(true);
    healthStates.set("codex", "signed_out");
    expect((await json(await get())).ready).toBe(false);
    healthStates.set("codex", "unknown");
    expect((await json(await get())).ready).toBe(false);
    healthStates.set("codex", "signed_in");
    db.run("UPDATE linear_session SET stopped_at=? WHERE session_id='session'", [now]);
    expect((await get()).status).toBe(404);
    db.run("UPDATE linear_session SET stopped_at=NULL WHERE session_id='session'");
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "observer",
      active: true,
      teamIds: ["team"],
      now: now + 1,
    });
    expect((await get()).status).toBe(404);
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds: ["team"],
      now: now + 2,
    });
    const second = workspaceId();
    addRunner(second);
    expect((await get(`/claude/login/${claude.id}`)).status).toBe(409);
    await fetch(`${origin}/api/workspaces/onboarding/vm`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ session: "session", generation: 0, runnerId: second }),
    });
    expect((await get(`/claude/login/${claude.id}`)).status).toBe(409);
    expect((await json(await get())).ready).toBe(false);
    advanceLinearSessionGeneration(db, "session", { now });
    expect((await get()).status).toBe(404);
    for (const row of db.query<{ kind: string }, []>("SELECT kind FROM runner_command").all())
      commands.push(row.kind);
    expect(commands.every((kind) => kind === "login")).toBe(true);
    expect(db.query("SELECT count(*) AS count FROM runner_work_grant").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM work_item").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM job").get()).toEqual({ count: 0 });
  } finally {
    login.stop();
    await server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
