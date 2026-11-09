import { expect, test } from "bun:test";
import {
  changeLinearTeamAccessSteps,
  dropLinearSessionDeliveriesSteps,
  getLinearInstallationPermissionsSteps,
  getLinearSessionAccessSteps,
  getLinearSessionInstallationSteps,
  getLinearTeamAccessSteps,
  hasLinearNotificationSteps,
  isLinearAppRevokedSteps,
  listLinearInstallationRevocationsSteps,
  listLinearInstallationSessionsSteps,
  recordLinearInstallationSteps,
  recordLinearNotificationSteps,
  restoreLinearInstallationSteps,
  revokeLinearInstallationSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, jsonValue, seed, type DialectDb } from "./dialects";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

function install(db: Db, sessionId: string, extra: { appUserId?: string; teamId?: string } = {}) {
  return db.transaction((q) =>
    recordLinearInstallationSteps(q, {
      ...scope,
      sessionId,
      teamId: "team",
      observedAtMs: 10,
      ...extra,
    }),
  );
}

function revoke(db: Db, eventKey: string, createdAtMs: number) {
  return db.transaction((q) =>
    revokeLinearInstallationSteps(q, {
      eventKey,
      organizationId: "org",
      oauthClientId: "client",
      createdAtMs,
    }),
  );
}

function teams(db: Db, eventKey: string, createdAtMs: number, change: object) {
  return db.transaction((q) =>
    changeLinearTeamAccessSteps(q, {
      ...scope,
      eventKey,
      createdAtMs,
      canAccessAllPublicTeams: true,
      addedTeamIds: [],
      removedTeamIds: [],
      ...change,
    }),
  );
}

forEachDialect((open) => {
  test("a notification is recorded once", async () =>
    withDb(open, async (db) => {
      const notification = { ...scope, notificationId: "n", createdAtMs: 5 };
      expect(await db.run((q) => hasLinearNotificationSteps(q, notification))).toBe(false);
      expect(await db.run((q) => recordLinearNotificationSteps(q, notification))).toBe(true);
      expect(await db.run((q) => recordLinearNotificationSteps(q, notification))).toBe(false);
      expect(await db.run((q) => hasLinearNotificationSteps(q, notification))).toBe(true);
    }));

  test("an installation observation keeps the latest and refuses a changed client", async () =>
    withDb(open, async (db) => {
      await install(db, "session");
      await expect(install(db, "session", { teamId: "older" })).rejects.toThrow(
        "team observations conflict",
      );
      await db.transaction((q) =>
        recordLinearInstallationSteps(q, {
          ...scope,
          sessionId: "session",
          teamId: "stale",
          observedAtMs: 5,
        }),
      );
      expect(await db.run((q) => getLinearSessionInstallationSteps(q, "session"))).toEqual({
        ...scope,
        teamId: "team",
        observedAtMs: 10,
      });
      await expect(
        db.transaction((q) =>
          recordLinearInstallationSteps(q, {
            ...scope,
            oauthClientId: "other",
            sessionId: "session",
            teamId: "team",
            observedAtMs: 20,
          }),
        ),
      ).rejects.toThrow("OAuth client ownership changed");
      expect(await db.run((q) => getLinearSessionInstallationSteps(q, "missing"))).toBeNull();
      expect(await db.run((q) => getLinearSessionAccessSteps(q, "missing"))).toBe("unknown");
    }));

  test("revocation counts its generation, keeps the later time and is restored once", async () =>
    withDb(open, async (db) => {
      await install(db, "b");
      await install(db, "a", { appUserId: "other" });
      expect(await revoke(db, "r1", 30)).toEqual(["a", "b"]);
      expect(await revoke(db, "r1", 30)).toEqual([]);
      expect(await revoke(db, "r2", 20)).toEqual(["a", "b"]);
      expect(await db.run((q) => listLinearInstallationRevocationsSteps(q))).toEqual([
        {
          organizationId: "org",
          oauthClientId: "client",
          generation: 2,
          revokedAtMs: 30,
          appUserIds: ["app", "other"],
        },
      ]);
      expect(await db.run((q) => getLinearSessionAccessSteps(q, "b"))).toBe("revoked");
      expect(
        await db.run((q) => isLinearAppRevokedSteps(q, { oauthClientId: null, appUserId: "app" })),
      ).toBe(true);
      expect(
        await db.run((q) => isLinearAppRevokedSteps(q, { oauthClientId: "x", appUserId: null })),
      ).toBe(false);

      await seed(db, (q) =>
        q.orm.insert(q.t.outbox).values({
          target: "linear",
          op: "activity",
          orderingKey: "b",
          idempotencyKey: "k",
          payload: jsonValue(q, {}),
          createdAt: 0,
        }),
      );
      const restore = (generation: number, grantStartedAtMs: number) =>
        db.transaction((q) =>
          restoreLinearInstallationSteps(q, {
            ...scope,
            generation,
            grantStartedAtMs,
            credentialFingerprint: "fp",
          }),
        );
      expect(await restore(1, 40)).toBe(false);
      expect(await restore(2, 30)).toBe(false);
      expect(await restore(2, 40)).toBe(true);
      expect(await restore(2, 50)).toBe(false);
      const deliveries = await db.run((q) =>
        q.all(
          q.orm.select({ status: q.t.outbox.status, error: q.t.outbox.error }).from(q.t.outbox),
        ),
      );
      expect(deliveries).toEqual([
        { status: "dropped", error: "Linear installation access was revoked." },
      ]);
      expect(await db.run((q) => listLinearInstallationRevocationsSteps(q))).toEqual([]);
      expect(await db.run((q) => getLinearSessionAccessSteps(q, "b"))).toBe("allowed");
      expect(await revoke(db, "r3", 35)).toEqual([]);
      expect(await revoke(db, "r4", 40)).toEqual(["a", "b"]);
    }));

  test("team access changes report the sessions they remove", async () =>
    withDb(open, async (db) => {
      await install(db, "session");
      await install(db, "elsewhere", { teamId: "other-team" });
      expect(await teams(db, "t1", 10, { addedTeamIds: ["team"] })).toEqual([]);
      expect(await db.run((q) => getLinearSessionAccessSteps(q, "session"))).toBe("allowed");
      expect(await teams(db, "t2", 9, { removedTeamIds: ["team"] })).toEqual([]);
      expect(await teams(db, "t3", 10, { removedTeamIds: ["team"] })).toEqual(["session"]);
      expect(await db.run((q) => getLinearTeamAccessSteps(q, { ...scope, teamId: "team" }))).toBe(
        "removed",
      );
      expect(await db.run((q) => getLinearTeamAccessSteps(q, { ...scope, teamId: "nope" }))).toBe(
        "unknown",
      );
      expect(await db.run((q) => getLinearSessionAccessSteps(q, "session"))).toBe("team_removed");
      expect(await teams(db, "t4", 11, { canAccessAllPublicTeams: false })).toEqual([
        "elsewhere",
        "session",
      ]);
      expect(await teams(db, "t5", 12, { canAccessAllPublicTeams: false })).toEqual([]);
      expect(await db.run((q) => getLinearInstallationPermissionsSteps(q, scope))).toEqual({
        canAccessAllPublicTeams: false,
        observedAtMs: 12,
      });
      expect(
        await db.run((q) =>
          listLinearInstallationSessionsSteps(q, {
            organizationId: "org",
            oauthClientId: "client",
          }),
        ),
      ).toEqual(["elsewhere", "session"]);
      expect(
        await db.run((q) =>
          listLinearInstallationSessionsSteps(q, { ...scope, appUserId: "nobody" }),
        ),
      ).toEqual([]);
    }));

  test("dropping a session's deliveries leaves other targets and sent rows", async () =>
    withDb(open, async (db) => {
      const row = (q: Q, key: string, extra: object) =>
        q.orm.insert(q.t.outbox).values({
          target: "linear",
          op: "activity",
          orderingKey: "session",
          idempotencyKey: key,
          payload: jsonValue(q, {}),
          createdAt: 0,
          ...extra,
        });
      await seed(
        db,
        (q) => row(q, "pending", {}),
        (q) => row(q, "dead", { status: "dead" }),
        (q) => row(q, "sent", { status: "sent" }),
        (q) => row(q, "github", { target: "github" }),
      );
      await db.run((q) => dropLinearSessionDeliveriesSteps(q, "session"));
      const rows = await db.run((q) =>
        q.all(
          q.orm
            .select({ key: q.t.outbox.idempotencyKey, status: q.t.outbox.status })
            .from(q.t.outbox)
            .orderBy(q.t.outbox.idempotencyKey),
        ),
      );
      expect(rows).toEqual([
        { key: "dead", status: "dropped" },
        { key: "github", status: "pending" },
        { key: "pending", status: "dropped" },
        { key: "sent", status: "sent" },
      ]);
    }));
});
