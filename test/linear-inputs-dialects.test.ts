import { expect, test } from "bun:test";
import { listLinearInputsSteps, recordLinearInputSteps, type LinearInputRecord } from "../src/db";
import { forEachDialect } from "./dialects";

const input = (assetId: string, size: number): LinearInputRecord => ({
  sessionId: "session",
  turnId: "turn",
  assetId,
  assetUrl: `https://uploads.linear.app/${assetId}`,
  mimeType: "image/png",
  size,
  sha256: `sha-${assetId}`,
});

forEachDialect((open) => {
  test("a turn's inputs are recorded once and listed by asset", async () => {
    const { db, close } = await open();
    try {
      await db.run((q) => recordLinearInputSteps(q, input("b", 2)));
      await db.run((q) => recordLinearInputSteps(q, input("a", 1)));
      await db.run((q) => recordLinearInputSteps(q, input("a", 99)));
      await db.run((q) => recordLinearInputSteps(q, { ...input("c", 3), turnId: "other" }));
      expect(await db.run((q) => listLinearInputsSteps(q, "session", "turn"))).toEqual([
        input("a", 1),
        input("b", 2),
      ]);
    } finally {
      await close();
    }
  });
});
