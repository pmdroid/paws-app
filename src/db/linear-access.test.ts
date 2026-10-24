import { expect, test } from "bun:test";
import { getLinearSessionInstallation, recordLinearInstallation } from "./linear-access";
import { migrate } from "./migrate";
import { openDatabase } from "./open";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

function database() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

test("a session read naming the team fills a teamless webhook observed in the same millisecond", () => {
  const db = database();
  try {
    recordLinearInstallation(db, { ...scope, sessionId: "s", teamId: null, observedAtMs: 5 });
    recordLinearInstallation(db, { ...scope, sessionId: "s", teamId: "team", observedAtMs: 5 });
    expect(getLinearSessionInstallation(db, "s")?.teamId).toBe("team");
    recordLinearInstallation(db, { ...scope, sessionId: "s", teamId: null, observedAtMs: 5 });
    expect(getLinearSessionInstallation(db, "s")?.teamId).toBe("team");
  } finally {
    db.close();
  }
});

test("two different teams observed in the same millisecond still conflict", () => {
  const db = database();
  try {
    recordLinearInstallation(db, { ...scope, sessionId: "s", teamId: "a", observedAtMs: 5 });
    expect(() =>
      recordLinearInstallation(db, { ...scope, sessionId: "s", teamId: "b", observedAtMs: 5 }),
    ).toThrow("Linear session team observations conflict");
  } finally {
    db.close();
  }
});
