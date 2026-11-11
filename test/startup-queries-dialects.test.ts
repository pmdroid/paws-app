import { expect, test } from "bun:test";
import {
  pruneRunnerEventsSteps,
  readDependencySnapshotSteps,
  saveDependencySnapshotSteps,
} from "../src/db";
import { forEachDialect, withoutForeignKeys } from "./dialects";

forEachDialect((open) => {
  test("pruning runner events runs on either dialect", async () => {
    const { db, close } = await open();
    try {
      expect(await db.run((q) => pruneRunnerEventsSteps(q, Date.now(), 10))).toBe(0);
    } finally {
      await close();
    }
  });

  test("a saved dependency snapshot reads back as the text it was saved from", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      const snapshot = {
        itemId: "item",
        workspaceId: "workspace",
        generation: 1,
        scope: JSON.stringify(["item", { teamId: "team", issueId: "issue" }]),
        linearStates: JSON.stringify([["issue", "started"]]),
        linearIdentifiers: JSON.stringify([["issue", "ACME-1"]]),
      };
      await db.run((q) => saveDependencySnapshotSteps(q, snapshot));
      expect(await db.run((q) => readDependencySnapshotSteps(q, "item"))).toEqual({
        generation: 1,
        scope: snapshot.scope,
        linearStates: snapshot.linearStates,
        linearIdentifiers: snapshot.linearIdentifiers,
        workspaceId: "workspace",
      });
    } finally {
      await close();
    }
  });
});
