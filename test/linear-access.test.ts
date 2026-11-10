import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  changeLinearTeamAccess,
  ensureLinearSession,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  getLinearInstallationPermissions,
  migrate,
  openDatabase,
  recordLinearInstallation,
  revokeLinearInstallation,
  sqliteDb,
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
function database(): Database {
  const db = tempDb();
  databases.push(db);
  return db;
}
function session(db: Database, sessionId = "session", extra = {}) {
  recordLinearInstallation(db, {
    ...scope,
    sessionId,
    teamId: "team",
    observedAtMs: 10,
    ...extra,
  });
}
async function teams(
  db: Database,
  eventKey: string,
  createdAtMs: number,
  addedTeamIds: string[],
  removedTeamIds: string[],
  extra = {},
) {
  return await changeLinearTeamAccess(sqliteDb(db), {
    ...scope,
    eventKey,
    createdAtMs,
    canAccessAllPublicTeams: true,
    addedTeamIds,
    removedTeamIds,
    ...extra,
  });
}

test("revocation is installation-wide while team removal has exact app-user and team scope", async () => {
  const db = database();
  session(db);
  session(db, "other-user", { appUserId: "other" });
  session(db, "other-team", { teamId: "other" });
  session(db, "other-client", { oauthClientId: "other" });
  session(db, "other-org", { organizationId: "other" });
  expect(await teams(db, "remove", 20, [], ["team"])).toEqual(["session"]);
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  for (const id of ["other-user", "other-team", "other-client", "other-org"])
    expect(getLinearSessionAccess(db, id)).toBe("allowed");
  expect(
    await revokeLinearInstallation(sqliteDb(db), { ...scope, eventKey: "revoke", createdAtMs: 30 }),
  ).toEqual(["other-team", "other-user", "session"]);
  for (const id of ["session", "other-user", "other-team"])
    expect(getLinearSessionAccess(db, id)).toBe("revoked");
  expect(getLinearSessionAccess(db, "other-client")).toBe("allowed");
  expect(getLinearSessionAccess(db, "other-org")).toBe("allowed");
});

test("team event ordering and deduplication cannot revive a newer removal", async () => {
  const db = database();
  session(db);
  expect(await teams(db, "remove", 30, [], ["team", "team"])).toEqual(["session"]);
  expect(await teams(db, "remove", 30, [], ["team"])).toEqual([]);
  expect(await teams(db, "old-add", 20, ["team"], [])).toEqual([]);
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  await teams(db, "same-add", 30, ["team"], []);
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  await teams(db, "new-add", 31, ["team"], []);
  expect(getLinearSessionAccess(db, "session")).toBe("allowed");
  expect(await teams(db, "old-remove", 29, [], ["team"])).toEqual([]);
  expect(getLinearSessionAccess(db, "session")).toBe("allowed");
});

test("revocation remains after prompts, stop recovery, newer session observations and team grants", async () => {
  const db = database();
  session(db);
  await revokeLinearInstallation(sqliteDb(db), { ...scope, eventKey: "revoke", createdAtMs: 20 });
  advanceLinearSessionGeneration(db, "session", { stop: true, now: 21 });
  advanceLinearSessionGeneration(db, "session", { now: 22 });
  session(db, "session", { observedAtMs: 23 });
  await teams(db, "grant", 24, ["team"], []);
  session(db, "new-session", { observedAtMs: 25 });
  expect(getLinearSessionAccess(db, "session")).toBe("revoked");
  expect(getLinearSessionAccess(db, "new-session")).toBe("revoked");
});

test("permission events arriving before session discovery fence later sessions", async () => {
  const db = database();
  expect(await teams(db, "remove", 20, [], ["team"])).toEqual([]);
  session(db);
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  await revokeLinearInstallation(sqliteDb(db), { ...scope, eventKey: "revoke", createdAtMs: 30 });
  session(db, "later", { teamId: "different" });
  expect(getLinearSessionAccess(db, "later")).toBe("revoked");
});

test("session ownership is immutable and old team observations cannot move the permission fence", async () => {
  const db = database();
  session(db);
  for (const extra of [
    { oauthClientId: "different" },
    { organizationId: "different" },
    { appUserId: "different" },
  ])
    expect(() => session(db, "session", extra)).toThrow("ownership changed");
  await teams(db, "remove", 20, [], ["team"]);
  session(db, "session", { teamId: "new-team", observedAtMs: 9 });
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  expect(() => session(db, "session", { teamId: "new-team", observedAtMs: 10 })).toThrow(
    "observations conflict",
  );
  session(db, "session", { teamId: "new-team", observedAtMs: 21 });
  expect(getLinearSessionAccess(db, "session")).toBe("allowed");
});

test("incomplete installation provenance fails closed and invalid changes roll back deduplication", async () => {
  const db = database();
  ensureLinearSession(db, { sessionId: "legacy" });
  expect(getLinearSessionAccess(db, "missing")).toBe("unknown");
  expect(getLinearSessionAccess(db, "legacy")).toBe("unknown");
  expect(getLinearSessionInstallation(db, "legacy")).toBeNull();
  session(db, "no-team", { teamId: null });
  expect(getLinearSessionAccess(db, "no-team")).toBe("unknown");
  await expect(teams(db, "invalid", 20, ["team"], ["team"])).rejects.toThrow("contradicts");
  expect(await teams(db, "invalid", 20, [], ["team"])).toEqual([]);
  session(db);
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  expect(() => session(db, "broken", { observedAtMs: NaN })).toThrow("timestamp");
  expect(() => session(db, "broken", { appUserId: " " })).toThrow("identity");
});

test("reopening SQLite preserves removal, revocation and processed event identities", async () => {
  const path = join(tempHome(), "access.db");
  let db = openDatabase(path);
  migrate(db);
  session(db);
  session(db, "revoked", { oauthClientId: "revoked-client" });
  await teams(db, "remove", 20, [], ["team"]);
  await revokeLinearInstallation(sqliteDb(db), {
    ...scope,
    oauthClientId: "revoked-client",
    eventKey: "revoke",
    createdAtMs: 30,
  });
  db.close();
  db = openDatabase(path);
  databases.push(db);
  migrate(db);
  expect(getLinearSessionAccess(db, "session")).toBe("team_removed");
  expect(getLinearSessionAccess(db, "revoked")).toBe("revoked");
  expect(getLinearSessionInstallation(db, "session")).toEqual({
    ...scope,
    teamId: "team",
    observedAtMs: 10,
  });
  expect(await teams(db, "remove", 20, [], ["team"])).toEqual([]);
  expect(
    await revokeLinearInstallation(sqliteDb(db), {
      ...scope,
      oauthClientId: "revoked-client",
      eventKey: "revoke",
      createdAtMs: 30,
    }),
  ).toEqual([]);
});

test("a public-team permission drop with empty team lists remains visible after restart", async () => {
  const path = join(tempHome(), "public-access.db");
  let db = openDatabase(path);
  migrate(db);
  session(db);
  session(db, "other-team", { teamId: "other" });
  await teams(db, "public-on", 20, [], []);
  expect(await teams(db, "public-off", 30, [], [], { canAccessAllPublicTeams: false })).toEqual([
    "other-team",
    "session",
  ]);
  expect(getLinearSessionAccess(db, "session")).toBe("allowed");
  db.close();
  db = openDatabase(path);
  databases.push(db);
  migrate(db);
  expect(await getLinearInstallationPermissions(sqliteDb(db), scope)).toEqual({
    canAccessAllPublicTeams: false,
    observedAtMs: 30,
  });
  await teams(db, "old-public-on", 25, [], []);
  expect(
    (await getLinearInstallationPermissions(sqliteDb(db), scope))?.canAccessAllPublicTeams,
  ).toBe(false);
  expect(await teams(db, "public-off", 30, [], [], { canAccessAllPublicTeams: false })).toEqual([]);
  session(db, "new-scope", { teamId: "new", observedAtMs: 31 });
  expect(
    (await getLinearInstallationPermissions(sqliteDb(db), scope))?.canAccessAllPublicTeams,
  ).toBe(false);
});
