import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "../../test/pglite";
import { seed } from "../../test/pglite-fixtures";
import { agentCredentialCiphertextSteps, createAgentAccountSteps } from "../db";
import { readAgentCredentialSteps } from "../credentials";
import { accessCredentialExpiry, accessCredentialFiles } from "../runner-protocol";
import { createAgentAuth, createOpencodeProvider } from "./index";
import { fakeOpencodeConsole } from "./fake";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  let time = 1_800_000_000_000;
  const now = () => time;
  const { db, close } = await tempStore();
  cleanup.push(close);
  const dir = mkdtempSync(join(tmpdir(), "opencode-auth-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = fakeOpencodeConsole();
  cleanup.push(fake.close);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "workspace",
        linearOrganizationId: "org",
        name: "Workspace",
        createdAt: time,
      }),
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
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "offline",
        workspaceId: "workspace",
        ownerUserId: "user",
        name: "Offline",
        status: "active",
        createdAt: time,
      }),
  );
  const account = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: "user",
      workspaceId: "workspace",
      agent: "opencode",
      label: "OpenCode",
      now: time,
    }),
  );
  const auth = createAgentAuth({
    store: db,
    secretsDir: dir,
    providers: { opencode: createOpencodeProvider(fake.server, now) },
    now,
  });
  const file = async () => {
    const credential = await db.run((q) => readAgentCredentialSteps(q, dir, account.id));
    const files = JSON.parse(credential!.blob!) as { path: string; data: string }[];
    return { files, auth: JSON.parse(Buffer.from(files[0]!.data, "base64").toString()) };
  };
  return { db, fake, auth, id: account.id, now, file, advance: (ms: number) => (time += ms) };
}
test("an OpenCode device sign-in with no runner online writes the CLI auth file and binds the owner's runners", async () => {
  const s = await setup();
  const device = await s.auth.device("workspace", s.id, true);
  expect(device).toEqual({
    userCode: "XBDM-QQNL",
    verificationUri: s.fake.server + "/device?user_code=XBDM-QQNL&client_id=opencode-cli",
    interval: 5,
    expiresAt: s.now() + 600_000,
  });
  expect(JSON.stringify(device)).not.toContain("device-secret");
  expect(s.fake.calls[0]).toEqual({
    path: "/console/auth/device/code",
    body: { client_id: "opencode-cli", supports_org_scope: true },
  });
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "pending" });
  expect(s.fake.calls[1]!.body).toEqual({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "device-secret",
    client_id: "opencode-cli",
  });
  s.fake.approve();
  s.advance(5000);
  expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: "signed-in" });
  const stored = await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id));
  expect(stored!.ciphertext).not.toContain("secret");
  const { files, auth } = await s.file();
  expect(files[0]!.path).toBe(".local/share/opencode/auth.json");
  expect(auth).toEqual({
    opencode: {
      type: "oauth",
      refresh: "refresh-secret-1",
      access: "access-secret-1",
      expires: s.now() + 3_600_000,
    },
  });
  const access = accessCredentialFiles(JSON.stringify(files));
  expect(JSON.parse(Buffer.from(access[0]!.data, "base64").toString()).opencode.refresh).toBe("");
  expect(accessCredentialExpiry(access)).toBe(s.now() + 3_600_000);
  expect(accessCredentialExpiry(files)).toBeNull();
  const bindings = await s.db.run((q) =>
    q.all(
      q.orm
        .select({ runnerId: q.t.agentAccountBinding.runnerId })
        .from(q.t.agentAccountBinding)
        .where(eq(q.t.agentAccountBinding.accountId, s.id)),
    ),
  );
  expect(bindings).toEqual([{ runnerId: "offline" }]);
  s.advance(3_000_000);
  await s.auth.tick();
  expect(s.fake.calls.at(-1)!.body).toEqual({
    grant_type: "refresh_token",
    refresh_token: "refresh-secret-1",
    client_id: "opencode-cli",
  });
  expect((await s.file()).auth.opencode).toMatchObject({
    refresh: "refresh-secret-2",
    access: "access-secret-2",
    expires: s.now() + 3_600_000,
  });
});
for (const outcome of ["denied", "expired"] as const)
  test(`an OpenCode sign-in that is ${outcome} stores nothing`, async () => {
    const s = await setup();
    await s.auth.device("workspace", s.id, true);
    if (outcome === "denied") s.fake.deny();
    else s.fake.expire();
    s.advance(5000);
    expect(await s.auth.device("workspace", s.id, false)).toEqual({ state: outcome });
    expect(await s.db.run((q) => agentCredentialCiphertextSteps(q, s.id))).toBeNull();
    expect(
      await s.db.run((q) =>
        q.all(
          q.orm
            .select()
            .from(q.t.agentAccountBinding)
            .where(eq(q.t.agentAccountBinding.accountId, s.id)),
        ),
      ),
    ).toEqual([]);
  });
