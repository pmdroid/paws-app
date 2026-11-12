import { afterEach, expect, test } from "bun:test";
import {
  advanceLinearSessionGeneration,
  changeLinearTeamAccess,
  ensureLinearSession,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  getLinearInstallationPermissions,
  recordLinearInstallation,
  revokeLinearInstallation,
  type Db,
} from "../src/db";
import { tempHome, withHomeStore } from "./helpers";
import { tempStore } from "./pglite";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
async function database() {
  const { db, close } = await tempStore();
  closes.push(close);
  return db;
}
async function session(db: Db, sessionId = "session", extra = {}) {
  await recordLinearInstallation(db, {
    ...scope,
    sessionId,
    teamId: "team",
    observedAtMs: 10,
    ...extra,
  });
}
async function teams(
  db: Db,
  eventKey: string,
  createdAtMs: number,
  addedTeamIds: string[],
  removedTeamIds: string[],
  extra = {},
) {
  return await changeLinearTeamAccess(db, {
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
  const db = await database();
  await session(db);
  await session(db, "other-user", { appUserId: "other" });
  await session(db, "other-team", { teamId: "other" });
  await session(db, "other-client", { oauthClientId: "other" });
  await session(db, "other-org", { organizationId: "other" });
  expect(await teams(db, "remove", 20, [], ["team"])).toEqual(["session"]);
  expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
  for (const id of ["other-user", "other-team", "other-client", "other-org"])
    expect(await getLinearSessionAccess(db, id)).toBe("allowed");
  expect(
    await revokeLinearInstallation(db, { ...scope, eventKey: "revoke", createdAtMs: 30 }),
  ).toEqual(["other-team", "other-user", "session"]);
  for (const id of ["session", "other-user", "other-team"])
    expect(await getLinearSessionAccess(db, id)).toBe("revoked");
  expect(await getLinearSessionAccess(db, "other-client")).toBe("allowed");
  expect(await getLinearSessionAccess(db, "other-org")).toBe("allowed");
});

test("team event ordering and deduplication cannot revive a newer removal", async () => {
  const db = await database();
  await session(db);
  expect(await teams(db, "remove", 30, [], ["team", "team"])).toEqual(["session"]);
  expect(await teams(db, "remove", 30, [], ["team"])).toEqual([]);
  expect(await teams(db, "old-add", 20, ["team"], [])).toEqual([]);
  expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
  await teams(db, "same-add", 30, ["team"], []);
  expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
  await teams(db, "new-add", 31, ["team"], []);
  expect(await getLinearSessionAccess(db, "session")).toBe("allowed");
  expect(await teams(db, "old-remove", 29, [], ["team"])).toEqual([]);
  expect(await getLinearSessionAccess(db, "session")).toBe("allowed");
});

test("revocation remains after prompts, stop recovery, newer session observations and team grants", async () => {
  const db = await database();
  await session(db);
  await revokeLinearInstallation(db, { ...scope, eventKey: "revoke", createdAtMs: 20 });
  await advanceLinearSessionGeneration(db, "session", { stop: true, now: 21 });
  await advanceLinearSessionGeneration(db, "session", { now: 22 });
  await session(db, "session", { observedAtMs: 23 });
  await teams(db, "grant", 24, ["team"], []);
  await session(db, "new-session", { observedAtMs: 25 });
  expect(await getLinearSessionAccess(db, "session")).toBe("revoked");
  expect(await getLinearSessionAccess(db, "new-session")).toBe("revoked");
});

test("permission events arriving before session discovery fence later sessions", async () => {
  const db = await database();
  expect(await teams(db, "remove", 20, [], ["team"])).toEqual([]);
  await session(db);
  expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
  await revokeLinearInstallation(db, { ...scope, eventKey: "revoke", createdAtMs: 30 });
  await session(db, "later", { teamId: "different" });
  expect(await getLinearSessionAccess(db, "later")).toBe("revoked");
});

test("session ownership is immutable and old team observations cannot move the permission fence", async () => {
  const db = await database();
  await session(db);
  for (const extra of [
    { oauthClientId: "different" },
    { organizationId: "different" },
    { appUserId: "different" },
  ])
    await expect(session(db, "session", extra)).rejects.toThrow("ownership changed");
  await teams(db, "remove", 20, [], ["team"]);
  await session(db, "session", { teamId: "new-team", observedAtMs: 9 });
  expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
  await expect(session(db, "session", { teamId: "new-team", observedAtMs: 10 })).rejects.toThrow(
    "observations conflict",
  );
  await session(db, "session", { teamId: "new-team", observedAtMs: 21 });
  expect(await getLinearSessionAccess(db, "session")).toBe("allowed");
});

test("incomplete installation provenance fails closed and invalid changes roll back deduplication", async () => {
  const db = await database();
  await ensureLinearSession(db, { sessionId: "legacy" });
  expect(await getLinearSessionAccess(db, "missing")).toBe("unknown");
  expect(await getLinearSessionAccess(db, "legacy")).toBe("unknown");
  expect(await getLinearSessionInstallation(db, "legacy")).toBeNull();
  await session(db, "no-team", { teamId: null });
  expect(await getLinearSessionAccess(db, "no-team")).toBe("unknown");
  await expect(teams(db, "invalid", 20, ["team"], ["team"])).rejects.toThrow("contradicts");
  expect(await teams(db, "invalid", 20, [], ["team"])).toEqual([]);
  await session(db);
  expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
  await expect(session(db, "broken", { observedAtMs: NaN })).rejects.toThrow("timestamp");
  await expect(session(db, "broken", { appUserId: " " })).rejects.toThrow("identity");
});

test("reopening the store preserves removal, revocation and processed event identities", async () => {
  const home = tempHome();
  await withHomeStore(home, async (db) => {
    await session(db);
    await session(db, "revoked", { oauthClientId: "revoked-client" });
    await teams(db, "remove", 20, [], ["team"]);
    await revokeLinearInstallation(db, {
      ...scope,
      oauthClientId: "revoked-client",
      eventKey: "revoke",
      createdAtMs: 30,
    });
  });
  await withHomeStore(home, async (db) => {
    expect(await getLinearSessionAccess(db, "session")).toBe("team_removed");
    expect(await getLinearSessionAccess(db, "revoked")).toBe("revoked");
    expect(await getLinearSessionInstallation(db, "session")).toEqual({
      ...scope,
      teamId: "team",
      observedAtMs: 10,
    });
    expect(await teams(db, "remove", 20, [], ["team"])).toEqual([]);
    expect(
      await revokeLinearInstallation(db, {
        ...scope,
        oauthClientId: "revoked-client",
        eventKey: "revoke",
        createdAtMs: 30,
      }),
    ).toEqual([]);
  });
});

test("a public-team permission drop with empty team lists remains visible after restart", async () => {
  const home = tempHome();
  await withHomeStore(home, async (db) => {
    await session(db);
    await session(db, "other-team", { teamId: "other" });
    await teams(db, "public-on", 20, [], []);
    expect(await teams(db, "public-off", 30, [], [], { canAccessAllPublicTeams: false })).toEqual([
      "other-team",
      "session",
    ]);
    expect(await getLinearSessionAccess(db, "session")).toBe("allowed");
  });
  await withHomeStore(home, async (db) => {
    expect(await getLinearInstallationPermissions(db, scope)).toEqual({
      canAccessAllPublicTeams: false,
      observedAtMs: 30,
    });
    await teams(db, "old-public-on", 25, [], []);
    expect((await getLinearInstallationPermissions(db, scope))?.canAccessAllPublicTeams).toBe(
      false,
    );
    expect(await teams(db, "public-off", 30, [], [], { canAccessAllPublicTeams: false })).toEqual(
      [],
    );
    await session(db, "new-scope", { teamId: "new", observedAtMs: 31 });
    expect((await getLinearInstallationPermissions(db, scope))?.canAccessAllPublicTeams).toBe(
      false,
    );
  });
});
