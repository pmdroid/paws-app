import { expect, test } from "bun:test";
import { getLinearSessionInstallation, recordLinearInstallation } from "./linear-access";
import { migrate } from "./migrate";
import { openDatabase } from "./open";
import { sqliteDb } from "./db";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

function database() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

test("a session read naming the team fills a teamless webhook observed in the same millisecond", async () => {
  const db = database();
  try {
    await recordLinearInstallation(sqliteDb(db), {
      ...scope,
      sessionId: "s",
      teamId: null,
      observedAtMs: 5,
    });
    await recordLinearInstallation(sqliteDb(db), {
      ...scope,
      sessionId: "s",
      teamId: "team",
      observedAtMs: 5,
    });
    expect((await getLinearSessionInstallation(sqliteDb(db), "s"))?.teamId).toBe("team");
    await recordLinearInstallation(sqliteDb(db), {
      ...scope,
      sessionId: "s",
      teamId: null,
      observedAtMs: 5,
    });
    expect((await getLinearSessionInstallation(sqliteDb(db), "s"))?.teamId).toBe("team");
  } finally {
    db.close();
  }
});

test("two different teams observed in the same millisecond still conflict", async () => {
  const db = database();
  try {
    await recordLinearInstallation(sqliteDb(db), {
      ...scope,
      sessionId: "s",
      teamId: "a",
      observedAtMs: 5,
    });
    await expect(
      recordLinearInstallation(sqliteDb(db), {
        ...scope,
        sessionId: "s",
        teamId: "b",
        observedAtMs: 5,
      }),
    ).rejects.toThrow("Linear session team observations conflict");
  } finally {
    db.close();
  }
});
