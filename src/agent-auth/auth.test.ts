import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "../../test/pglite";
import { seed } from "../../test/dialects";
import {
  agentCredentialCiphertextSteps,
  createAgentAccountSteps,
  takeAgentAccountLeaseSteps,
  bindAgentAccountSteps,
  bindingAccountHealthSteps,
  centralAgentAccountsSteps,
  agentAccountOverviewSteps,
} from "../db";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../credentials";
import { createAgentAuth, createCodexProvider } from "./index";
import { fakeCodexOAuth } from "./fake";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
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
  const account = await db.transaction((q) =>
    createAgentAccountSteps(q, {
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
test("refresh persists rotated tokens under a runner lease and health gates every reader", async () => {
  const s = await setup();
  await seed(
    s.db,
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "user", linearUserId: "user", name: "User", email: "user@example.test" }),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "workspace",
        userId: "user",
        role: "admin",
        source: "manual",
        active: 1,
        checkedAt: s.now(),
      }),
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
  const binding = await s.db.transaction((q) => bindAgentAccountSteps(q, holder));
  await s.db.transaction((q) =>
    takeAgentAccountLeaseSteps(q, { ...holder, runId: "run", until: s.now() + 10_000_000 }),
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
