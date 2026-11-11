import { expect, test } from "bun:test";
import { migrate, openDatabase, putWorkspaceUser, syncWorkspaceMember, sqliteDb } from "../db";
import type { AgentModelCatalog } from "../runner-models";
import type { WorkspacePrincipal } from "../workspace";
import {
  createFakeRetroCatalog,
  createRetroSettingsHttp,
  proposedRetroSettings,
  RETRO_SETTINGS_PATH,
  type RetroSettingsView,
} from "./index";

const APP = "pmdroid/paws-app";
const CATALOGS: AgentModelCatalog[] = [
  {
    agent: "codex",
    updatedAt: 1,
    efforts: [{ id: "high", name: "High" }],
    defaultModel: "gpt-6-astra",
    models: [
      {
        id: "gpt-6-astra",
        name: "gpt-6-astra",
        longContext: false,
        efforts: [{ id: "high", name: "High" }],
        defaultEffort: "high",
      },
    ],
  },
];

function fixture(catalogs: AgentModelCatalog[] | null = CATALOGS) {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team-1')", [APP]);
  const member = async (linearUserId: string, role: "admin" | "member", active = true) => {
    const userId = await putWorkspaceUser(sqliteDb(db), {
      id: `user-${linearUserId}`,
      linearUserId,
      name: linearUserId,
      email: `${linearUserId}@example.invalid`,
    });
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: "ws",
      userId,
      role,
      active,
      teamIds: [],
      now: 1,
    });
    const principal: WorkspacePrincipal = {
      workspaceId: "ws",
      userId,
      role,
      authenticatedAt: 1,
      teamIds: [],
    };
    return principal;
  };
  const catalog = createFakeRetroCatalog(catalogs);
  const handle = createRetroSettingsHttp({
    store: sqliteDb(db),
    catalog: catalog.read,
    now: () => 5,
  });
  const audit = () =>
    db
      .query<{ action: string; subject: string }, []>(
        "SELECT action, subject FROM workspace_access_audit WHERE action IN ('settings.retros.saved','access.denied') ORDER BY id",
      )
      .all();
  return { db, member, handle, catalog, audit };
}

const put = (body: unknown) =>
  new Request(`http://127.0.0.1${RETRO_SETTINGS_PATH}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
const get = () => new Request(`http://127.0.0.1${RETRO_SETTINGS_PATH}`);
const settings = () => ({
  ...proposedRetroSettings([APP]),
  agentProfile: { agent: "codex", model: "gpt-6-astra", effort: "high" },
});

test("a member reads the settings and an admin saves them with an audit entry", async () => {
  const { member, handle, audit, catalog } = fixture();
  const admin = await member("admin", "admin");
  const reader = await member("reader", "member");
  const before = (await (await handle(get(), reader))!.json()) as RetroSettingsView;
  expect(before).toMatchObject({ revision: 0, saved: false, canEdit: false });
  expect(before.accessibleRepositories).toEqual([APP]);

  const saved = await handle(put({ expectedRevision: 0, settings: settings() }), admin);
  expect(saved!.status).toBe(200);
  expect(await saved!.json()).toMatchObject({ revision: 1, saved: true, canEdit: true });
  expect(catalog.calls).toEqual([{ workspaceId: "ws", userId: admin.userId }]);
  expect(audit()).toEqual([{ action: "settings.retros.saved", subject: "revision 1" }]);

  const after = (await (await handle(get(), reader))!.json()) as RetroSettingsView;
  expect(after.settings.agentProfile).toEqual({
    agent: "codex",
    model: "gpt-6-astra",
    effort: "high",
  });
});

test("a member cannot save and the refusal is audited", async () => {
  const { member, handle, audit } = fixture();
  const response = await handle(
    put({ expectedRevision: 0, settings: settings() }),
    await member("reader", "member"),
  );
  expect(response!.status).toBe(403);
  expect(audit()).toEqual([{ action: "access.denied", subject: RETRO_SETTINGS_PATH }]);
});

test("an inactive member cannot read", async () => {
  const { member, handle } = fixture();
  expect((await handle(get(), await member("gone", "member", false)))!.status).toBe(403);
});

test("a conflict returns the saved revision with the unchanged draft", async () => {
  const { member, handle } = fixture();
  const admin = await member("admin", "admin");
  await handle(put({ expectedRevision: 0, settings: settings() }), admin);
  const draft = { ...settings(), outputLimits: { maxItems: 2, workedWell: 1 } };
  const response = await handle(put({ expectedRevision: 0, settings: draft }), admin);
  expect(response!.status).toBe(409);
  const body = await response!.json();
  expect(body).toMatchObject({ reason: "conflict", current: { revision: 1 }, draft });
});

test("inaccessible repositories and unavailable catalogs are told apart", async () => {
  const { member, handle } = fixture(null);
  const admin = await member("admin", "admin");
  const inaccessible = await handle(
    put({ expectedRevision: 0, settings: { ...settings(), repositories: ["other/repo"] } }),
    admin,
  );
  expect(inaccessible!.status).toBe(400);
  expect(((await inaccessible!.json()) as { reason: string }).reason).toBe(
    "inaccessible_repository",
  );
  const unavailable = await handle(put({ expectedRevision: 0, settings: settings() }), admin);
  expect(unavailable!.status).toBe(503);
  expect(((await unavailable!.json()) as { reason: string }).reason).toBe("catalog_unavailable");
});

test("other paths and methods are not handled as saves", async () => {
  const { member, handle } = fixture();
  const admin = await member("admin", "admin");
  expect(await handle(new Request("http://127.0.0.1/api/retros/other"), admin)).toBeNull();
  expect(
    (await handle(
      new Request(`http://127.0.0.1${RETRO_SETTINGS_PATH}`, { method: "POST" }),
      admin,
    ))!.status,
  ).toBe(405);
  expect((await handle(put({ settings: settings() }), admin))!.status).toBe(400);
});
