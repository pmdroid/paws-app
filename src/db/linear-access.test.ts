import { expect, test } from "bun:test";
import { getLinearSessionInstallation, recordLinearInstallation } from "./linear-access";
import { tempStore } from "../../test/pglite";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

test("a session read naming the team fills a teamless webhook observed in the same millisecond", async () => {
  const { db, close } = await tempStore();
  try {
    await recordLinearInstallation(db, {
      ...scope,
      sessionId: "s",
      teamId: null,
      observedAtMs: 5,
    });
    await recordLinearInstallation(db, {
      ...scope,
      sessionId: "s",
      teamId: "team",
      observedAtMs: 5,
    });
    expect((await getLinearSessionInstallation(db, "s"))?.teamId).toBe("team");
    await recordLinearInstallation(db, {
      ...scope,
      sessionId: "s",
      teamId: null,
      observedAtMs: 5,
    });
    expect((await getLinearSessionInstallation(db, "s"))?.teamId).toBe("team");
  } finally {
    await close();
  }
});

test("two different teams observed in the same millisecond still conflict", async () => {
  const { db, close } = await tempStore();
  try {
    await recordLinearInstallation(db, {
      ...scope,
      sessionId: "s",
      teamId: "a",
      observedAtMs: 5,
    });
    await expect(
      recordLinearInstallation(db, {
        ...scope,
        sessionId: "s",
        teamId: "b",
        observedAtMs: 5,
      }),
    ).rejects.toThrow("Linear session team observations conflict");
  } finally {
    await close();
  }
});
