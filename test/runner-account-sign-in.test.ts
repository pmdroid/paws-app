import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindAgentAccount,
  bindingAccountHealth,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordAccountObservation,
  setAgentAccountEnabled,
  sqliteDb,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerLogin } from "../src/runner-login";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(runnerVersion = "0.1.61") {
  const root = mkdtempSync(join(tmpdir(), "paws-account-sign-in-"));
  roots.push(root);
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = 1_800_000_000_000;
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-host", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-host",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId,
    role: "admin",
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
    serverVersion: "2.3.4",
  });
  const enroll = async (name: string) => {
    const client = await createRunnerKey(join(root, name));
    const pending = { name, csr: client.csr };
    return (
      await control.enroll({
        ...pending,
        token: (await control.createEnrollment(principal, pending)).token,
      })
    ).runnerId;
  };
  const runnerId = await enroll("goldbox");
  const otherRunner = await enroll("silverbox");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const http = createRunnerWorkHttp(work, {});
  const heartbeat = async (bindings: { bindingId: string; agent: string }[]) =>
    (await http(
      new Request("https://runner.invalid/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerVersion, accounts: { protocol: 1, bindings } }),
      }),
      runnerId,
    ))!.status;
  expect(await heartbeat([])).toBe(200);
  const signedIn: string[] = [];
  const login = createRunnerLogin({
    db,
    work,
    now: () => now,
    onSignedIn: ({ agent }) => signedIn.push(agent),
  });
  const health = createRunnerHealth({ db, work, now: () => now });
  const account = await createAgentAccount(sqliteDb(db), {
    workspaceId: workspace.id,
    agent: "codex",
    label: "Second",
    now,
  });
  const binding = await bindAgentAccount(sqliteDb(db), {
    workspaceId: workspace.id,
    accountId: account.id,
    runnerId,
    now,
  });
  const queued = async () =>
    (await work.commands(runnerId)).map(
      (envelope) =>
        JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as {
          id: string;
          type: string;
          account?: { accountId: string; bindingId: string };
        },
    );
  const browser = (path: string) =>
    login.browser(
      new Request(`https://paws.invalid/api/runners/${runnerId}/accounts/${path}`, {
        method: "POST",
      }),
      principal,
    );
  return {
    db,
    now,
    runnerId,
    otherRunner,
    workspace: workspace.id,
    principal,
    login,
    health,
    account,
    binding,
    queued,
    browser,
    signedIn,
    work,
    heartbeat,
  };
}

const policy = (db: ReturnType<typeof openDatabase>, runnerId: string) =>
  db
    .query<{ ready: number }, [string]>(
      "SELECT ready FROM runner_agent_policy WHERE runner_id=? AND agent='codex'",
    )
    .get(runnerId);

test("a named sign-in targets only its binding and leaves the default sign-in alone", async () => {
  const { db, runnerId, principal, login, account, binding, queued, signedIn } = await fixture();
  const named = await login.start(principal, runnerId, "codex", binding.id);
  expect(named.bindingId).toBe(binding.id);
  expect((await login.start(principal, runnerId, "codex", binding.id)).id).toBe(named.id);
  const legacy = await login.start(principal, runnerId, "codex");
  expect(legacy.id).not.toBe(named.id);
  expect(legacy.bindingId).toBeNull();
  expect((await queued()).map(({ id, type, account: target }) => ({ id, type, target }))).toEqual([
    {
      id: named.id,
      type: "login",
      target: { accountId: account.id, bindingId: binding.id },
    },
    { id: legacy.id, type: "login", target: undefined },
  ]);

  await login.exchange(runnerId, named.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  expect(policy(db, runnerId)).toBeNull();
  expect(signedIn).toEqual([]);
  await login.exchange(runnerId, legacy.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  expect(policy(db, runnerId)?.ready).toBe(1);
  expect(signedIn).toEqual(["codex"]);

  const again = await login.start(principal, runnerId, "codex", binding.id);
  expect(again.id).not.toBe(named.id);
  expect(
    (await login.list(principal, runnerId)).accounts.find((entry) => entry.agent === "codex")
      ?.session?.id,
  ).toBe(legacy.id);
  expect((await login.list(principal, runnerId)).bindings).toEqual([
    {
      accountId: account.id,
      bindingId: binding.id,
      agent: "codex",
      label: "Second",
      enabled: true,
      held: expect.any(Boolean),
      running: 0,
      session: expect.objectContaining({ id: again.id, bindingId: binding.id, state: "starting" }),
    },
  ]);
  db.close();
});

test("a completed named sign-in repairs only its binding's sign-in failure", async () => {
  const { db, now, runnerId, otherRunner, workspace, principal, login, account, binding } =
    await fixture();
  const other = await bindAgentAccount(sqliteDb(db), {
    workspaceId: workspace,
    accountId: account.id,
    runnerId: otherRunner,
    now,
  });
  for (const bindingId of [binding.id, other.id])
    recordAccountObservation(db, {
      bindingId,
      source: "result",
      sourceId: `failed-${bindingId}`,
      observedAt: now - 1,
      now: now - 1,
      state: "auth_required",
    });
  const named = await login.start(principal, runnerId, "codex", binding.id);
  await login.exchange(runnerId, named.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  const auth = (bindingId: string) =>
    bindingAccountHealth(db, bindingId).find((row) => row.kind === "auth")?.state;
  expect(auth(binding.id)).toBe("ok");
  expect(auth(other.id)).toBe("auth_required");
  expect(policy(db, runnerId)).toBeNull();
  db.close();
});

test("a disabled account can still sign in; a foreign or removed binding cannot", async () => {
  const { db, now, runnerId, otherRunner, workspace, principal, login, account, binding, browser } =
    await fixture();
  await setAgentAccountEnabled(sqliteDb(db), {
    workspaceId: workspace,
    accountId: account.id,
    enabled: false,
    now,
  });
  expect((await login.start(principal, runnerId, "codex", binding.id)).bindingId).toBe(binding.id);
  await expect(login.start(principal, runnerId, "claude", binding.id)).rejects.toThrow(
    /not available/,
  );
  const elsewhere = await bindAgentAccount(sqliteDb(db), {
    workspaceId: workspace,
    accountId: account.id,
    runnerId: otherRunner,
    now,
  });
  await expect(login.start(principal, runnerId, "codex", elsewhere.id)).rejects.toThrow(
    /not available/,
  );
  expect((await browser(`codex/login?binding=${elsewhere.id}`))!.status).toBe(409);
  expect((await browser("codex/login?binding=..%2Fx"))!.status).toBe(400);
  expect((await browser("codex/login?binding=01JMISSING0000000000000000"))!.status).toBe(403);
  db.close();
});

test("a runner without account sign-in keeps refusing a named sign-in", async () => {
  const { db, runnerId, principal, login, binding, queued, browser } = await fixture("0.1.59");
  await expect(login.start(principal, runnerId, "codex", binding.id)).rejects.toThrow(/0\.1\.61/);
  const response = (await browser(`codex/login?binding=${binding.id}`))!;
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toMatch(/0\.1\.61/);
  expect(await queued()).toEqual([]);
  db.close();
});

test("re-signing in a binding waits until its running work drains", async () => {
  const { db, now, runnerId, workspace, principal, login, account, binding } = await fixture();
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES('run-1',?,?,1,0,'command-1',?)",
    [runnerId, workspace, now + 60_000],
  );
  db.run(
    "INSERT INTO runner_command_account(command_id,workspace_id,runner_id,agent,account_id,binding_id,named,recorded_at) VALUES('command-1',?,?,'codex',?,?,1,?)",
    [workspace, runnerId, account.id, binding.id, now],
  );
  db.run("PRAGMA foreign_keys=ON");
  await expect(login.start(principal, runnerId, "codex", binding.id)).rejects.toThrow(
    /still running/,
  );
  expect((await login.start(principal, runnerId, "codex")).bindingId).toBeNull();
  db.run("UPDATE runner_work SET ended_at=? WHERE run_id='run-1'", [now]);
  expect((await login.start(principal, runnerId, "codex", binding.id)).bindingId).toBe(binding.id);
  db.close();
});

test("a named sign-in check does not change the default sign-in's readiness or usage", async () => {
  const { db, now, runnerId, workspace, health, account, binding, work, heartbeat } =
    await fixture();
  expect(await heartbeat([{ bindingId: binding.id, agent: "codex" }])).toBe(200);
  const target = { accountId: account.id, bindingId: binding.id };
  work.enqueue({
    id: "named-check",
    type: "login_check",
    runnerId,
    workspaceId: workspace,
    agent: "codex",
    issuedAt: now,
    expiresAt: now + 60_000,
    account: target,
  });
  const result = {
    executionId: "01J00000000000000000000001",
    commandId: "named-check",
    role: "implementer" as const,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    agentLimits: [{ window: "Weekly", usedPercent: 100, resetsAt: now + 60_000 }],
    login: {
      agent: "codex" as const,
      authenticated: true,
      method: "subscription" as const,
    },
  };
  await expect(health.submit(runnerId, result)).rejects.toThrow(/contradicts/);
  expect(await health.submit(runnerId, { ...result, account: target })).toEqual({
    duplicate: false,
  });
  expect(policy(db, runnerId)).toBeNull();
  expect(
    db.query("SELECT COUNT(*) AS count FROM runner_agent_usage WHERE runner_id=?").get(runnerId),
  ).toEqual({ count: 0 });
  db.close();
});
