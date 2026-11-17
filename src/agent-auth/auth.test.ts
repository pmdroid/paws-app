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
} from "./index";
import { UsageAuthExpired, UsageUnavailable } from "./usage";
import { fakeCodexOAuth } from "./fake";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(signedIn = false) {
  let time = 1_800_000_000_000;
  const now = () => time;
  const { db, close } = await tempStore();
  cleanup.push(close);
  const dir = mkdtempSync(join(tmpdir(), "agent-auth-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeCodexOAuth(now);
  cleanup.push(fake.close);
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
      agent: "codex",
      label: "Codex",
      now: time,
    }),
  );
  const auth = createAgentAuth({
    store: db,
    secretsDir: dir,
    provider: createCodexProvider(fake.issuer, now),
    now,
  });
  if (signedIn) {
    await auth.device("workspace", account.id, true);
    fake.approve();
    time += 5000;
    await auth.device("workspace", account.id, false);
  }
  return {
    db,
    dir,
    fake,
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
    provider: {
      ...provider,
      async pollDevice(device) {
        entered.resolve();
        await release.promise;
        return provider.pollDevice(device);
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
