import { afterEach, expect, test } from "bun:test";
import { assertLinearSessionCleanupSteps, blockLinearSessionCleanupSteps } from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a blocked session cleanup fails the assertion for it and for all sessions", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await db.run((q) => assertLinearSessionCleanupSteps(q));
    await db.run((q) => blockLinearSessionCleanupSteps(q, "s1"));
    await db.run((q) => blockLinearSessionCleanupSteps(q, "s1"));
    await db.run((q) => assertLinearSessionCleanupSteps(q, "s2"));
    expect(db.run((q) => assertLinearSessionCleanupSteps(q, "s1"))).rejects.toThrow(
      "ACP process cleanup could not be verified",
    );
    expect(db.run((q) => assertLinearSessionCleanupSteps(q))).rejects.toThrow(
      "ACP process cleanup could not be verified",
    );
  });
});
