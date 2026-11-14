import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "../../test/pglite";
import { seed } from "../../test/dialects";
import { agentCredentialCiphertextSteps, createAgentAccountSteps, readAgentAuthSteps } from "../db";
import { readAgentCredentialSteps } from "../credentials";
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
    interval: 5,
  });
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  s.fake.approve();
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "signed-in" });
  const stored = await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id));
  expect(stored!.ciphertext).not.toContain("refresh-secret");
  const credential = await s.db.run((q) => readAgentCredentialSteps(q, s.dir, s.id));
  const files = JSON.parse(credential!.blob!);
  expect(files[0].path).toBe(".codex/auth.json");
  expect(JSON.parse(Buffer.from(files[0].data, "base64").toString()).tokens.refresh_token).toBe(
    "refresh-secret",
  );
  s.advance(2_999_000);
  await s.auth.tick();
  expect(s.fake.calls.filter((p) => p === "/oauth/token")).toHaveLength(1);
  s.advance(1000);
  await Promise.all([s.auth.tick(), s.auth.tick()]);
  expect(s.fake.calls.filter((p) => p === "/oauth/token")).toHaveLength(2);
  s.advance(3_000_000);
  s.fake.failRefresh();
  await s.auth.tick();
  const state = JSON.parse((await s.db.run((q) => readAgentAuthSteps(q, s.id)))!);
  expect(state.health).toBe("auth-expired");
  await s.auth.tick();
  expect(s.fake.calls.filter((p) => p === "/oauth/token")).toHaveLength(3);
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
