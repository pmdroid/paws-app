import { expect, test } from "bun:test";
import { openPawsStore, replaceLinearProjectTeamsSteps, type Q } from "../src/db";
import { pgliteServer, sqlRows, sqlRun } from "./pglite";
import { waitFor } from "./wait-for";

const replace = (teamIds: string[], now: number) => (q: Q) =>
  replaceLinearProjectTeamsSteps(q, { workspaceId: "w", projectId: "p", teamIds, now });
const LOCK_WAITS = "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'";

test("concurrent replaces of one project on two connections commit, update seen_at and delete removed teams", async () => {
  const server = await pgliteServer();
  const { store: first } = server;
  const other = await openPawsStore({ url: server.url, pgliteDir: "" });
  const teams = () =>
    sqlRows(first, "SELECT team_id, seen_at::int AS seen_at FROM linear_project_team ORDER BY 1");
  try {
    await sqlRun(
      first,
      "INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES ('w', 'o', 'W', 0)",
    );
    await first.transaction(replace(["x", "a", "a"], 0));
    const held = Promise.withResolvers<void>();
    const replaced = Promise.withResolvers<void>();
    const a = first.transaction(function* (q) {
      yield* replace(["a", "b"], 1)(q);
      replaced.resolve();
      yield* q.exec(held.promise);
    });
    await replaced.promise;
    const b = other.store.transaction(replace(["b", "c"], 2));
    if (process.env.PAWS_TEST_DATABASE_URL)
      await waitFor(async () => (await sqlRows(first, LOCK_WAITS)).length > 0);
    held.resolve();
    await Promise.all([a, b]);
    expect((await teams()).filter((row) => row.team_id !== "a")).toEqual([
      { team_id: "b", seen_at: 2 },
      { team_id: "c", seen_at: 2 },
    ]);
    await first.transaction(replace([], 3));
    expect(await teams()).toEqual([]);
  } finally {
    await other.close();
    await server.close();
  }
});
