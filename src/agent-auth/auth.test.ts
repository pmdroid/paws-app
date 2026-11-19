import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "../../test/pglite";
import { seed } from "../../test/pglite-fixtures";
import {
  readAgentAuthSteps,
  writeAgentAuthSteps,
  providerUsageSteps,
  agentCredentialCiphertextSteps,
  createAgentAccountSteps,
  bindAgentAccountSteps,
  bindingAccountHealthSteps,
  centralAgentAccountsSteps,
  agentAccountOverviewSteps,
} from "../db";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../credentials";
import {
  createAccountUsage,
  createUsageReader,
  createAgentAuth,
  createCodexProvider,
  createGrokProvider,
} from "./index";
import { UsageAuthExpired, UsageUnavailable } from "./usage";
import { fakeCodexOAuth, fakeXaiOAuth } from "./fake";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(signedIn = false, agent: "codex" | "grok" = "codex") {
  let time = 1_800_000_000_000;
  const now = () => time;
  const { db, close } = await tempStore();
  cleanup.push(close);
  const dir = mkdtempSync(join(tmpdir(), "agent-auth-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeCodexOAuth(now);
  cleanup.push(fake.close);
  const xai = fakeXaiOAuth(now);
  cleanup.push(xai.close);
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: time }),
  );
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "user", linearUserId: "user", name: "User", email: "user@test.invalid" }),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "workspace",
        userId: "user",
        role: "owner",
        source: "manual",
        active: 1,
        checkedAt: time,
      }),
  );
  const account = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: "user",
      workspaceId: "workspace",
      agent,
      label: "Codex",
      now: time,
    }),
  );
  const auth = createAgentAuth({
    store: db,
    secretsDir: dir,
    providers: {
      codex: createCodexProvider(fake.issuer, now),
      grok: createGrokProvider(xai.issuer, now),
    },
    now,
  });
  if (signedIn) {
    await auth.device("workspace", account.id, true);
    (agent === "grok" ? xai : fake).approve();
    time += 5000;
    await auth.device("workspace", account.id, false);
  }
  return {
    db,
    dir,
    fake,
    xai,
    auth,
    id: account.id,
    now,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
test("device approval encrypts CLI credentials and refreshes once across concurrent ticks", async () => {
  const s = await setup();
  expect(await s.auth.device("workspace", s.id, true)).toMatchObject({
    userCode: "USER-CODE",
    verificationUri: s.fake.issuer + "/codex/device",
  });
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  s.fake.approve();
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "signed-in" });
  const stored = await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id));
  expect(stored!.ciphertext).not.toContain("refresh-secret");
  const credential = await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id));
  const files = JSON.parse(credential!.blob!);
  expect(JSON.parse(Buffer.from(files[0].data, "base64").toString()).tokens.refresh_token).toBe(
    "refresh-secret-1",
  );
  s.advance(2_999_000);
  await s.auth.tick();
  expect(s.fake.calls.filter((p) => p === "/oauth/token")).toHaveLength(1);
  s.advance(1000);
  await Promise.all([s.auth.tick(), s.auth.tick()]);
  expect(s.fake.calls.filter((p) => p === "/oauth/token")).toHaveLength(2);
});
test("device sign-in binds the account to every active runner its owner has", async () => {
  const s = await setup();
  await seed(
    s.db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "active",
        workspaceId: "workspace",
        ownerUserId: "user",
        name: "Active",
        status: "active",
        createdAt: s.now(),
      }),
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "revoked",
        workspaceId: "workspace",
        ownerUserId: "user",
        name: "Revoked",
        status: "active",
        createdAt: s.now(),
        revokedAt: s.now(),
      }),
  );
  await s.auth.device("workspace", s.id, true);
  s.fake.approve();
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "signed-in" });
  const bindings = await s.db.run((q) =>
    q.all(
      q.orm
        .select({ runnerId: q.t.agentAccountBinding.runnerId })
        .from(q.t.agentAccountBinding)
        .where(eq(q.t.agentAccountBinding.accountId, s.id)),
    ),
  );
  expect(bindings).toEqual([{ runnerId: "active" }]);
});
for (const outcome of ["denied", "expired", "timeout"] as const)
  test(outcome + " stores no credential", async () => {
    const s = await setup();
    await s.auth.device("workspace", s.id, true);
    if (outcome === "denied") s.fake.deny();
    if (outcome === "expired") s.fake.expire();
    s.advance(outcome === "timeout" ? 900_000 : 5000);
    expect(await s.auth.device("workspace", s.id, false)).toEqual({
      state: outcome === "denied" ? "denied" : "expired",
    });
    expect(await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id))).toBeNull();
  });
test("refresh persists rotated tokens from a bound runner and health gates every reader", async () => {
  const s = await setup();
  await seed(
    s.db,
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "user", linearUserId: "user", name: "User", email: "user@example.test" })
        .onConflictDoNothing(),
    (q) =>
      q.orm
        .insert(q.t.workspaceMember)
        .values({
          workspaceId: "workspace",
          userId: "user",
          role: "admin",
          source: "manual",
          active: 1,
          checkedAt: s.now(),
        })
        .onConflictDoNothing(),
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "runner",
        workspaceId: "workspace",
        ownerUserId: "user",
        name: "Runner",
        status: "active",
        createdAt: s.now(),
      }),
  );
  const holder = { workspaceId: "workspace", accountId: s.id, runnerId: "runner", now: s.now() };
  const binding = await s.db.transaction((q) =>
    bindAgentAccountSteps(q, { userId: "user", ...holder }),
  );
  await s.auth.device("workspace", s.id, true);
  s.fake.approve();
  s.advance(5000);
  await s.auth.device("workspace", s.id, false);
  const uploaded = await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id));
  expect(
    await s.db.transaction((q) =>
      writeAgentCredentialSteps(q, s.dir, {
        accountId: s.id,
        runnerId: "runner",
        version: 2,
        blob: uploaded!.blob!,
        now: s.now(),
      }),
    ),
  ).toBe("written");
  s.advance(3_000_000);
  await s.auth.tick();
  const credential = await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id));
  expect(credential!.version).toBe(3);
  s.advance(3_000_000);
  s.fake.failRefresh();
  await s.auth.tick();
  expect(await s.db.run((q) => centralAgentAccountsSteps(q, "workspace", "codex"))).toHaveLength(0);
  expect(
    (await s.db.run((q) => bindingAccountHealthSteps(q, binding.id))).some(
      (h) => h.state === "auth_required",
    ),
  ).toBe(true);
  expect(
    (await s.db.run((q) => agentAccountOverviewSteps(q, "workspace", s.now())))[0]!.credential,
  ).toBeNull();
  s.fake.failRefresh(false);
  s.advance(60_000);
  await s.auth.tick();
  expect(await s.db.run((q) => centralAgentAccountsSteps(q, "workspace", "codex"))).toHaveLength(1);
});
test("a replaced in-flight device poll cannot report sign-in success", async () => {
  const s = await setup();
  const provider = createCodexProvider(s.fake.issuer, s.now);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const auth = createAgentAuth({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    providers: {
      codex: {
        ...provider,
        async pollDevice(device) {
          entered.resolve();
          await release.promise;
          return provider.pollDevice(device);
        },
      },
    },
  });
  await auth.device("workspace", s.id, true);
  s.fake.approve();
  s.advance(5000);
  const poll = auth.device("workspace", s.id, false);
  await entered.promise;
  await auth.device("workspace", s.id, true);
  release.resolve();
  expect(await poll).toEqual({ state: "pending" });
  expect(await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id))).toBeNull();
});

test("provider usage persists per account, polls five minutes, rereads after runs and preserves stale usage", async () => {
  const s = await setup(true);
  let calls = 0;
  let status = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json(
        {
          rate_limit: {
            primary_window: {
              used_percent: 100,
              limit_window_seconds: 18000,
              reset_at: 2000000000,
            },
          },
        },
        { status },
      );
    },
  });
  cleanup.push(() => server.stop(true));
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: createUsageReader({ codex: server.url.origin, claude: server.url.origin }, s.now),
  });
  await usage.tick();
  const read = () => s.db.run((q) => providerUsageSteps(q, s.id));
  const first = (await read())!;
  expect(JSON.parse(first.limitsJson!).limits).toEqual([
    { window: "5-hour", usedPercent: 100, resetsAt: 2000000000000 },
  ]);
  expect(
    (await s.db.run((q) => centralAgentAccountsSteps(q, "workspace", "codex")))[0]!.limits,
  ).toHaveLength(1);
  s.advance(300000);
  await usage.tick();
  expect(calls).toBe(2);
  expect(JSON.parse((await read())!.limitsJson!).observedAt).toBe(s.now());
  await usage.tick(s.id);
  expect(calls).toBe(3);
  const last = JSON.parse((await read())!.limitsJson!).observedAt;
  s.advance(3600000);
  await usage.tick();
  expect(calls).toBe(3);
  expect(JSON.parse((await read())!.limitsJson!).observedAt).toBe(last);
  expect(JSON.parse((await read())!.limitsJson!).stale).toBe(true);
  s.advance(-3600000);
  status = 401;
  await usage.tick(s.id);
  expect(await s.db.run((q) => centralAgentAccountsSteps(q, "workspace", "codex"))).toHaveLength(0);
  expect(JSON.parse((await read())!.limitsJson!).observedAt).toBe(last);
  expect(JSON.parse((await read())!.limitsJson!).stale).toBe(true);
});
test("poll latency does not skip the next five-minute read and overlapping run completions reread", async () => {
  const s = await setup(true);
  let calls = 0;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: async () => {
      calls++;
      if (calls === 2) {
        entered.resolve();
        await release.promise;
      }
      s.advance(1000);
      return [{ window: "5-hour", usedPercent: calls, resetsAt: null }];
    },
  });
  await usage.tick();
  s.advance(299000);
  const periodic = usage.tick();
  await entered.promise;
  const firstRun = usage.tick(s.id),
    secondRun = usage.tick(s.id);
  release.resolve();
  await Promise.all([periodic, firstRun, secondRun]);
  expect(calls).toBe(4);
  expect(
    JSON.parse((await s.db.run((q) => providerUsageSteps(q, s.id)))!.limitsJson!).limits[0]
      .usedPercent,
  ).toBe(4);
});
for (const error of [new UsageAuthExpired(), new Error("provider unavailable")])
  test(`replaced credential ignores in-flight ${error.constructor.name}`, async () => {
    const s = await setup(true);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let fail = false;
    const usage = createAccountUsage({
      store: s.db,
      secretsDir: s.dir,
      now: s.now,
      readUsage: async () => {
        if (fail) {
          entered.resolve();
          await release.promise;
          throw error;
        }
        return [];
      },
    });
    await usage.tick();
    fail = true;
    const pending = usage.tick(s.id);
    await entered.promise;
    const credential = (await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id)))!;
    await s.db.transaction((q) =>
      writeAgentCredentialSteps(q, s.dir, {
        accountId: s.id,
        runnerId: null,
        version: 2,
        blob: credential.blob!,
        now: s.now(),
      }),
    );
    const state = JSON.stringify({
      state: "signed-in",
      version: 2,
      health: "ok",
      retryAt: 0,
      failures: 0,
    });
    await s.db.transaction((q) => writeAgentAuthSteps(q, s.id, state));
    release.resolve();
    await pending;
    expect(await s.db.run((q) => readAgentAuthSteps(q, s.id))).toBe(state);
    expect(
      JSON.parse((await s.db.run((q) => providerUsageSteps(q, s.id)))!.limitsJson!).stale,
    ).toBe(false);
  });
test("every scheduled poll reads later accounts despite changing latency", async () => {
  const s = await setup(true);
  const other = await s.db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: "user",
      workspaceId: "workspace",
      agent: "codex",
      label: "Second",
      now: s.now(),
    }),
  );
  const credential = (await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id)))!;
  await s.db.transaction((q) =>
    writeAgentCredentialSteps(q, s.dir, {
      accountId: other.id,
      runnerId: null,
      version: 1,
      blob: credential.blob!,
      now: s.now(),
    }),
  );
  let calls = 0;
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: async () => {
      if (++calls === 1) s.advance(1000);
      return [];
    },
  });
  await usage.tick();
  expect(calls).toBe(2);
  s.advance(299000);
  await usage.tick();
  expect(calls).toBe(4);
});
test("a refused read stores the reason and the poll still reads the other account", async () => {
  const s = await setup(true);
  const other = await s.db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: "user",
      workspaceId: "workspace",
      agent: "codex",
      label: "Second",
      now: s.now(),
    }),
  );
  const credential = (await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id)))!;
  await s.db.transaction((q) =>
    writeAgentCredentialSteps(q, s.dir, {
      accountId: other.id,
      runnerId: null,
      version: 1,
      blob: credential.blob!,
      now: s.now(),
    }),
  );
  let calls = 0;
  let refuse = true;
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: async () => {
      if (++calls === 1 && refuse) throw new UsageUnavailable("Usage unavailable (HTTP 429)");
      return [{ window: "5-hour", usedPercent: 10, resetsAt: null }];
    },
  });
  await usage.tick();
  expect(calls).toBe(2);
  const stored = async () =>
    (
      await Promise.all([s.id, other.id].map((id) => s.db.run((q) => providerUsageSteps(q, id))))
    ).map((row) => JSON.parse(row!.limitsJson!));
  const [refused, read] = (await stored()).sort((a, b) => a.limits.length - b.limits.length);
  expect(refused).toEqual({
    limits: [],
    observedAt: s.now(),
    stale: true,
    unavailable: "Usage unavailable (HTTP 429)",
  });
  expect(read.limits).toEqual([{ window: "5-hour", usedPercent: 10, resetsAt: null }]);
  expect(read.unavailable).toBeUndefined();
  refuse = false;
  calls = 0;
  await usage.tick();
  for (const reading of await stored()) {
    expect(reading.limits).toHaveLength(1);
    expect(reading.unavailable).toBeUndefined();
  }
});
test("a read that fails without an HTTP status still stores that usage is unavailable", async () => {
  const s = await setup(true);
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: async () => {
      throw new Error("The operation timed out.");
    },
  });
  await usage.tick();
  expect(
    JSON.parse((await s.db.run((q) => providerUsageSteps(q, s.id)))!.limitsJson!).unavailable,
  ).toBe("Usage unavailable");
});
const SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
async function grokFile(s: Awaited<ReturnType<typeof setup>>) {
  const stored = await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id));
  const files = JSON.parse(stored!.blob!) as { path: string; data: string }[];
  expect(files.map((entry) => entry.path)).toEqual([".grok/auth.json"]);
  return JSON.parse(Buffer.from(files[0]!.data, "base64").toString());
}
test("device approval with no runner online writes .grok/auth.json under the scope key and binds runners", async () => {
  const s = await setup(false, "grok");
  await seed(s.db, (q) =>
    q.orm.insert(q.t.runner).values({
      id: "offline",
      workspaceId: "workspace",
      ownerUserId: "user",
      name: "Offline",
      status: "active",
      createdAt: s.now(),
    }),
  );
  const started = await s.auth.device("workspace", s.id, true);
  expect(started).toEqual({
    userCode: "GROK-CODE",
    verificationUri: "https://accounts.x.ai/device?user_code=GROK-CODE",
    interval: 5,
    expiresAt: s.now() + 600_000,
  });
  expect(s.xai.calls[0]).toEqual({
    path: "/oauth2/device/code",
    form: {
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      scope:
        "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write",
    },
  });
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  expect(s.xai.calls[1]!.form).toEqual({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "device-secret",
    client_id: "b1a00492-073a-47ea-816f-4c329264a828",
  });
  s.xai.slowDown();
  s.advance(5000);
  await s.auth.device("workspace", s.id, false);
  s.xai.approve();
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  expect(s.xai.calls).toHaveLength(3);
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "signed-in" });
  const stored = await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id));
  expect(stored!.ciphertext).not.toContain("xai-access");
  expect(await grokFile(s)).toEqual({
    [SCOPE]: {
      key: "xai-access-1",
      auth_mode: "oidc",
      create_time: new Date(s.now()).toISOString(),
      user_id: "user-42",
      email: "grok@test.invalid",
      refresh_token: "xai-refresh-1",
      expires_at: new Date(s.now() + 3_600_000).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      coding_data_retention_opt_out: true,
      team_blocked_reasons: [],
    },
  });
  const bindings = await s.db.run((q) =>
    q.all(
      q.orm
        .select({ runnerId: q.t.agentAccountBinding.runnerId })
        .from(q.t.agentAccountBinding)
        .where(eq(q.t.agentAccountBinding.accountId, s.id)),
    ),
  );
  expect(bindings).toEqual([{ runnerId: "offline" }]);
});
for (const outcome of ["deny", "expire"] as const)
  test(`a device code that the person ${outcome === "deny" ? "denies" : "lets expire"} stores nothing`, async () => {
    const s = await setup(false, "grok");
    await s.auth.device("workspace", s.id, true);
    s.xai[outcome]();
    s.advance(5000);
    expect(await s.auth.device("workspace", s.id, false)).toEqual({
      state: outcome === "deny" ? "denied" : "expired",
    });
    expect(await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id))).toBeNull();
  });
test("refresh rotates the key with the refresh_token grant and keeps the identity", async () => {
  const s = await setup(false, "grok");
  await s.auth.device("workspace", s.id, true);
  s.xai.approve();
  s.advance(5000);
  await s.auth.device("workspace", s.id, false);
  s.advance(3_000_000);
  await s.auth.tick();
  expect(s.xai.calls.at(-1)).toEqual({
    path: "/oauth2/token",
    form: {
      grant_type: "refresh_token",
      refresh_token: "xai-refresh-1",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    },
  });
  expect((await grokFile(s))[SCOPE]).toMatchObject({
    key: "xai-access-2",
    refresh_token: "xai-refresh-2",
    user_id: "user-42",
    email: "grok@test.invalid",
    expires_at: new Date(s.now() + 3_600_000).toISOString(),
  });
});

test("an exhausted Grok window marks the account exhausted until it resets", async () => {
  const s = await setup(true, "grok");
  const end = s.now() + 86_400_000;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        config: {
          credit_usage_percent: 100,
          current_period: {
            period_type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: new Date(end).toISOString(),
          },
        },
      }),
  });
  cleanup.push(() => server.stop(true));
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: createUsageReader(
      { codex: server.url.origin, claude: server.url.origin, grok: server.url.origin },
      s.now,
    ),
  });
  await usage.tick();
  const health = (await s.db.run((q) => providerUsageSteps(q, s.id)))!;
  expect(health.state).toBe("exhausted");
  expect(health.resetsAt).toBe(end);
  expect(JSON.parse(health.limitsJson!).limits).toEqual([
    { window: "Weekly", usedPercent: 100, resetsAt: end },
  ]);
});

async function grokUsage(s: Awaited<ReturnType<typeof setup>>, refresh: boolean) {
  const keys: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const key = request.headers.get("authorization") ?? "";
      keys.push(key);
      return key === "Bearer xai-access-2"
        ? Response.json({ config: { credit_usage_percent: 40, current_period: null } })
        : new Response(null, { status: 401 });
    },
  });
  cleanup.push(() => server.stop(true));
  const usage = createAccountUsage({
    store: s.db,
    secretsDir: s.dir,
    now: s.now,
    readUsage: createUsageReader(
      { codex: server.url.origin, claude: server.url.origin, grok: server.url.origin },
      s.now,
    ),
    ...(refresh ? { refresh: (id: string) => s.auth.refresh(id) } : {}),
  });
  await usage.tick();
  const row = await s.db.run((q) => providerUsageSteps(q, s.id));
  const overview = await s.db.run((q) => agentAccountOverviewSteps(q, "workspace", s.now()));
  return { keys, stored: JSON.parse(row!.limitsJson!), usage: overview[0]!.usage };
}
test("an expired Grok key with no earlier usage stores a stale sign-in reason the dashboard shows", async () => {
  const s = await setup(true, "grok");
  s.advance(3_700_000);
  const result = await grokUsage(s, false);
  expect(result.keys).toEqual([]);
  const expected = {
    limits: [],
    observedAt: s.now(),
    stale: true,
    unavailable: "Sign in again to see usage",
  };
  expect(result.stored).toEqual(expected);
  expect(result.usage).toEqual(expected);
});
test("an expired Grok key is refreshed with its refresh token and usage is stored", async () => {
  const s = await setup(true, "grok");
  s.advance(3_700_000);
  const result = await grokUsage(s, true);
  expect(result.keys).toEqual(["Bearer xai-access-2"]);
  expect(s.xai.calls.at(-1)!.form.grant_type).toBe("refresh_token");
  expect((await grokFile(s))[SCOPE].key).toBe("xai-access-2");
  expect(result.stored).toEqual({
    limits: [{ window: "Monthly", usedPercent: 40, resetsAt: null }],
    observedAt: s.now(),
    stale: false,
  });
});
test("a 401 from Grok billing refreshes like expiry and shows the sign-in reason when refresh fails", async () => {
  const s = await setup(true, "grok");
  const stored = (await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id)))!;
  const files = JSON.parse(stored.blob!) as { path: string; data: string }[];
  const auth = JSON.parse(Buffer.from(files[0]!.data, "base64").toString());
  auth[SCOPE].refresh_token = null;
  await s.db.transaction((q) =>
    writeAgentCredentialSteps(q, s.dir, {
      accountId: s.id,
      runnerId: null,
      version: 2,
      blob: JSON.stringify([
        { path: ".grok/auth.json", data: Buffer.from(JSON.stringify(auth)).toString("base64") },
      ]),
      now: s.now(),
    }),
  );
  const calls = s.xai.calls.length;
  const result = await grokUsage(s, true);
  expect(result.keys).toEqual(["Bearer xai-access-1"]);
  expect(s.xai.calls).toHaveLength(calls);
  expect(result.stored).toMatchObject({ stale: true, unavailable: "Sign in again to see usage" });
});
