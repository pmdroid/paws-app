import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  listRunnerAgentsSteps,
  listRunnerOverviewSteps,
  listRunnerRuntimesSteps,
  noteRunnerSeenSteps,
  recordRunnerAccountCapabilitySteps,
  recordRunnerAgentsSteps,
  recordRunnerCapacityWakingSteps,
  recordRunnerHostStatusSteps,
  recordRunnerRepositoriesSteps,
  recordRunnerRuntimesSteps,
  type Q,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";
import { insertRunnerSteps } from "./runner-dialect-seed";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await handle.db.run((q) => insertRunnerSteps(q, "box"));
  return handle.db;
}

forEachDialect((connect) => {
  test("a repeated runtime and agent report keeps each unchanged row as it was", async () => {
    const db = await connected(connect);
    const runtimes = (status: "installed" | "failed") => [
      { tool: "node", version: "22", status: "installed" as const },
      { tool: "go", version: "1.23", status, error: "no network" },
    ];
    await db.run((q) => recordRunnerRuntimesSteps(q, "box", runtimes("failed"), 10));
    await db.run((q) => recordRunnerRuntimesSteps(q, "box", runtimes("failed"), 20));
    await db.run((q) => recordRunnerRuntimesSteps(q, "box", runtimes("installed"), 30));
    expect(await db.run((q) => listRunnerRuntimesSteps(q, "box"))).toEqual([
      { tool: "go", version: "1.23", status: "installed", error: null, reportedAt: 30 },
      { tool: "node", version: "22", status: "installed", error: null, reportedAt: 10 },
    ]);
    await db.run((q) => recordRunnerRuntimesSteps(q, "box", runtimes("installed").slice(1), 40));
    expect((await db.run((q) => listRunnerRuntimesSteps(q, "box"))).map((r) => r.tool)).toEqual([
      "go",
    ]);

    const agents = (sessions: number) => [
      { agent: "claude", version: "1.0.0", status: "current" as const },
      { agent: "claude", version: "1.1.0", status: "waiting" as const, sessions },
      { agent: "claude", version: "1.2.0", status: "waiting" as const, sessions: 9 },
    ];
    const stored = (q: Q) =>
      q.all(
        q.orm
          .select({
            version: q.t.runnerAgent.version,
            sessions: q.t.runnerAgent.sessions,
            reportedAt: q.t.runnerAgent.reportedAt,
          })
          .from(q.t.runnerAgent)
          .orderBy(q.t.runnerAgent.version),
      );
    await db.run((q) => recordRunnerAgentsSteps(q, "box", agents(2), 10));
    await db.run((q) => recordRunnerAgentsSteps(q, "box", agents(2), 20));
    await db.run((q) => recordRunnerAgentsSteps(q, "box", agents(1), 30));
    expect(await db.run(stored)).toEqual([
      { version: "1.0.0", sessions: null, reportedAt: 10 },
      { version: "1.1.0", sessions: 1, reportedAt: 30 },
    ]);
    await db.run((q) => recordRunnerAgentsSteps(q, "box", agents(1).slice(0, 1), 40));
    expect((await db.run((q) => listRunnerAgentsSteps(q, "box")))[0]).toMatchObject({
      current: "1.0.0",
      reportedAt: 10,
    });
    expect(await db.run(stored)).toHaveLength(1);
  });

  test("a repeated host, capacity, repository and account report leaves the stored rows", async () => {
    const db = await connected(connect);
    const host = (cpuPercent: number) => ({ cpuPercent, runnerVersion: "1.2.3" });
    const capability = (bindingId: string) => ({
      protocol: 1,
      bindings: [{ bindingId, agent: "claude" as const }],
    });
    function* heartbeat(q: Q, at: number, cpu: number, repositories: string[], binding: string) {
      yield* noteRunnerSeenSteps(q, "box", at);
      yield* recordRunnerHostStatusSteps(q, "box", host(cpu), at);
      yield* recordRunnerCapacityWakingSteps(q, "box", 2, 4, 1, at);
      yield* recordRunnerRepositoriesSteps(q, "box", repositories, at);
      yield* recordRunnerAccountCapabilitySteps(q, "box", capability(binding), at);
    }
    const stored = (q: Q) =>
      q.all(
        q.orm
          .select({
            host: q.t.runnerHostStatus.reportedAt,
            repositories: q.t.runnerRepositories.reportedAt,
            accounts: q.t.runnerAccountCapability.reportedAt,
          })
          .from(q.t.runnerHostStatus)
          .innerJoin(
            q.t.runnerRepositories,
            eq(q.t.runnerRepositories.runnerId, q.t.runnerHostStatus.runnerId),
          )
          .innerJoin(
            q.t.runnerAccountCapability,
            eq(q.t.runnerAccountCapability.runnerId, q.t.runnerHostStatus.runnerId),
          ),
      );
    await db.run((q) => heartbeat(q, 10, 5, ["acme/app"], "work"));
    await db.run((q) => heartbeat(q, 20, 5, ["acme/app"], "work"));
    expect(await db.run(stored)).toEqual([{ host: 10, repositories: 10, accounts: 10 }]);
    const [runner] = await db.run((q) => listRunnerOverviewSteps(q, "acme", 20));
    expect(runner?.metrics?.reportedAt).toBe(20);
    expect(runner?.concurrency).toMatchObject({ applied: 2, ceiling: 4 });

    await db.run((q) => heartbeat(q, 30, 7, ["acme/app", "acme/api"], "home"));
    expect(await db.run(stored)).toEqual([{ host: 30, repositories: 30, accounts: 30 }]);
    await db.run((q) => recordRunnerCapacityWakingSteps(q, "box", 3, 4, 1, 40));
    const [after] = await db.run((q) => listRunnerOverviewSteps(q, "acme", 40));
    expect(after?.metrics?.cpuPercent).toBe(7);
    expect(after?.concurrency).toMatchObject({ applied: 3, ceiling: 4 });
  });
});
