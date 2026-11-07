import { afterEach, expect, test } from "bun:test";
import {
  listRunnerAgentsSteps,
  recordRunnerAgentsSteps,
  requestAllRunnerAgentUpdatesSteps,
  requestRunnerAgentUpdateSteps,
  runnerAgentTargetsSteps,
  RunnerAgentUpdateError,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";
import { insertRunnerSteps } from "./runner-dialect-seed";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const packages = (agent: string, nativeVersion: string | null) =>
  nativeVersion === null
    ? []
    : [{ name: `${agent}-native`, version: nativeVersion, integrity: "sha512-n" }];

function* insertVersionSteps(
  q: Q,
  version: string,
  status = "eligible",
  integrity = `sha512-${version}`,
) {
  yield* q.exec(
    q.orm.insert(q.t.agentVersion).values({
      agent: "claude",
      version,
      integrity,
      status,
      firstSeenAt: 0,
      nativeVersion: version,
      checkedAt: 10,
      reason: status === "eligible" ? null : "Too new.",
    }),
  );
}

async function seed(db: Db): Promise<void> {
  await db.run(function* (q) {
    yield* insertRunnerSteps(q, "box");
    yield* insertVersionSteps(q, "1.0.0");
    yield* insertVersionSteps(q, "1.1.0");
    yield* insertVersionSteps(q, "1.2.0", "waiting");
    yield* recordRunnerAgentsSteps(
      q,
      "box",
      [{ agent: "claude", version: "1.0.0", status: "current" }],
      100,
    );
  });
}

forEachDialect((connect) => {
  test("a requested version is sent to the runner and shown as pending until the runner runs it", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await seed(db);
    const request = {
      workspaceId: "acme",
      userId: "owner",
      now: 200,
      runnerId: "box",
      agent: "claude",
    };

    await db.transaction((q) =>
      requestRunnerAgentUpdateSteps(q, {
        ...request,
        id: "t1",
        version: "1.1.0",
        catalogPackages: packages,
      }),
    );
    expect(await db.run((q) => runnerAgentTargetsSteps(q, "box"))).toEqual([
      {
        id: "t1",
        agent: "claude",
        version: "1.1.0",
        integrity: "sha512-1.1.0",
        nativeVersion: "1.1.0",
        packages: [{ name: "claude-native", version: "1.1.0", integrity: "sha512-n" }],
      },
    ]);
    expect(await db.run((q) => listRunnerAgentsSteps(q, "box"))).toEqual([
      {
        agent: "claude",
        current: "1.0.0",
        pending: {
          version: "1.1.0",
          status: "requested",
          sessions: null,
          error: null,
          requestedAt: 200,
        },
        reportedAt: 100,
      },
    ]);

    await db.run((q) =>
      recordRunnerAgentsSteps(
        q,
        "box",
        [
          { agent: "claude", version: "1.0.0", status: "current" },
          { agent: "claude", version: "1.1.0", status: "waiting", target: "t1", sessions: 2 },
        ],
        300,
      ),
    );
    expect((await db.run((q) => listRunnerAgentsSteps(q, "box")))[0]!.pending).toEqual({
      version: "1.1.0",
      status: "waiting",
      sessions: 2,
      error: null,
      requestedAt: 200,
    });

    await db.run((q) =>
      recordRunnerAgentsSteps(
        q,
        "box",
        [{ agent: "claude", version: "1.1.0", status: "current" }],
        400,
      ),
    );
    expect(await db.run((q) => runnerAgentTargetsSteps(q, "box"))).toEqual([]);
    expect(await db.run((q) => listRunnerAgentsSteps(q, "box"))).toEqual([
      { agent: "claude", current: "1.1.0", pending: null, reportedAt: 400 },
    ]);

    const refused = db.transaction((q) =>
      requestRunnerAgentUpdateSteps(q, {
        ...request,
        id: "t2",
        version: "1.2.0",
        catalogPackages: packages,
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(RunnerAgentUpdateError);
    await expect(refused).rejects.toThrow("Claude 1.2.0 is not an eligible version: Too new.");
  });

  test("updating every runner moves each agent forward to the newest eligible version once", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await seed(db);
    let next = 0;
    const input = {
      workspaceId: "acme",
      userId: "owner",
      now: 200,
      id: () => `all-${(next += 1)}`,
      catalogPackages: packages,
    };

    expect(await db.transaction((q) => requestAllRunnerAgentUpdatesSteps(q, input))).toBe(1);
    expect(await db.transaction((q) => requestAllRunnerAgentUpdatesSteps(q, input))).toBe(0);
    await db.run((q) =>
      recordRunnerAgentsSteps(
        q,
        "box",
        [
          { agent: "claude", version: "1.0.0", status: "current" },
          {
            agent: "claude",
            version: "1.1.0",
            status: "failed",
            target: "all-1",
            error: "disk full",
          },
        ],
        300,
      ),
    );
    expect((await db.run((q) => listRunnerAgentsSteps(q, "box")))[0]!.pending).toMatchObject({
      status: "failed",
      error: "disk full",
    });
    expect(await db.transaction((q) => requestAllRunnerAgentUpdatesSteps(q, input))).toBe(1);
    expect(
      (await db.run((q) => runnerAgentTargetsSteps(q, "box"))).map((target) => target.id),
    ).toEqual(["all-2"]);
  });
});
