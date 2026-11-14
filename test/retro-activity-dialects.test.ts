import { expect, test } from "bun:test";
import { migrationTags, PG_MIGRATIONS_FOLDER, readRetroActivity } from "../src/db";
import { forEachDialect } from "./dialects";

forEachDialect((open) => {
  test("an empty workspace's activity names the latest applied migration", async () => {
    const { db, close } = await open();
    try {
      const tags = migrationTags(PG_MIGRATIONS_FOLDER);
      const snapshot = await readRetroActivity(db, {
        workspaceId: "ws",
        repositories: ["acme/widgets"],
        before: 100,
      });
      expect(snapshot.schema).toEqual({
        latest: tags.at(-1)!,
        applied: tags.length,
      });
    } finally {
      await close();
    }
  });
});
