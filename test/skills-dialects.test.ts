import { afterEach, expect, test } from "bun:test";
import {
  getSkillSteps,
  listRunnerSkillsSteps,
  listSkillsSteps,
  markSkillRemovedSteps,
  recordRunAgentSetupSteps,
  recordRunnerSkillsSteps,
  runAgentSetupSteps,
  runnerSkillStatesSteps,
  saveSkillSteps,
  setSkillAgentsSteps,
  skillRolloutsSteps,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const sha = (char: string) => char.repeat(64);

forEachDialect((connect) => {
  test("skills save, change agents, tombstone and come back", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    const skill = (name: string, at: number) => ({
      name,
      source: { kind: "npm" as const, package: `@x/${name}` },
      version: "1.0.0",
      sha256: sha("a"),
      sizeBytes: 10,
      agents: ["claude" as const],
      updatedAt: at,
    });
    await db.run((q) => saveSkillSteps(q, skill("b", 1)));
    await db.run((q) => saveSkillSteps(q, skill("a", 2)));
    await db.run((q) => setSkillAgentsSteps(q, "a", ["codex", "grok"], 3));
    await db.run((q) => markSkillRemovedSteps(q, "a", 4));
    await db.run((q) => setSkillAgentsSteps(q, "a", ["claude"], 5));
    expect(await db.run(listSkillsSteps)).toEqual([
      { ...skill("b", 1), createdAt: 1, removedAt: null },
      { ...skill("a", 4), agents: ["codex", "grok"], createdAt: 2, removedAt: 4 },
    ]);
    await db.run((q) => saveSkillSteps(q, { ...skill("a", 6), version: "2.0.0" }));
    expect(await db.run((q) => getSkillSteps(q, "a"))).toEqual({
      ...skill("a", 6),
      version: "2.0.0",
      createdAt: 2,
      removedAt: null,
    });
    expect(await db.run((q) => getSkillSteps(q, "missing"))).toBeNull();
  });

  test("runner reports set skill states, rollouts and a run's agent setup", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const runner = (id: string, createdAt: number, revokedAt: number | null = null) => ({
      id,
      workspaceId: "acme",
      ownerUserId: "owner",
      name: id,
      status: revokedAt === null ? "active" : "revoked",
      createdAt,
      revokedAt,
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.runner).values([runner("one", 1), runner("two", 2), runner("gone", 3, 3)]),
    );
    const pin = (name: string, char: string) => ({
      name,
      source: { kind: "upload" as const, folder: name },
      version: char,
      sha256: sha(char),
      sizeBytes: 1,
      agents: ["claude" as const],
      updatedAt: 1,
    });
    await db.run((q) => saveSkillSteps(q, pin("lint", "a")));
    await db.run((q) => saveSkillSteps(q, pin("old", "b")));
    await db.run((q) => saveSkillSteps(q, pin("ship", "c")));
    await db.run((q) => markSkillRemovedSteps(q, "old", 2));

    await db.run((q) =>
      recordRunnerSkillsSteps(
        q,
        "one",
        [
          {
            name: "ship",
            version: "c",
            sha256: sha("c"),
            status: "pending",
            waiting: 2,
            error: "x",
          },
          { name: "lint", version: "a", sha256: sha("a"), status: "installed" },
          { name: "old", version: "b", sha256: sha("b"), status: "installed" },
        ],
        10,
      ),
    );
    // A tombstone stays while a live runner still has the skill.
    expect((await db.run(listSkillsSteps)).map((entry) => entry.name)).toEqual([
      "lint",
      "ship",
      "old",
    ]);
    await db.run((q) =>
      recordRunnerSkillsSteps(
        q,
        "one",
        [
          {
            name: "ship",
            version: "c",
            sha256: sha("c"),
            status: "pending",
            waiting: 2,
            error: "x",
          },
          { name: "lint", version: "a", sha256: sha("a"), status: "installed" },
        ],
        11,
      ),
    );
    await db.run((q) =>
      recordRunnerSkillsSteps(
        q,
        "two",
        [{ name: "lint", version: "0", sha256: sha("0"), status: "refused", error: "too big" }],
        12,
      ),
    );
    expect((await db.run(listSkillsSteps)).map((entry) => entry.name)).toEqual(["lint", "ship"]);
    expect(await db.run((q) => listRunnerSkillsSteps(q, "one"))).toEqual([
      {
        name: "lint",
        version: "a",
        sha256: sha("a"),
        status: "installed",
        error: null,
        waiting: null,
        reportedAt: 11,
      },
      {
        name: "ship",
        version: "c",
        sha256: sha("c"),
        status: "pending",
        error: null,
        waiting: 2,
        reportedAt: 11,
      },
    ]);
    expect(await db.run((q) => runnerSkillStatesSteps(q, "two"))).toEqual([
      {
        name: "lint",
        version: "a",
        installedVersion: null,
        state: "installing",
        error: null,
        waiting: null,
        reportedAt: 12,
      },
      {
        name: "ship",
        version: "c",
        installedVersion: null,
        state: "installing",
        error: null,
        waiting: null,
        reportedAt: null,
      },
    ]);
    expect(await db.run((q) => skillRolloutsSteps(q))).toEqual([
      {
        name: "lint",
        total: 2,
        upToDate: 1,
        installing: ["two"],
        waiting: [],
        outOfDate: [],
        failed: [],
      },
      {
        name: "ship",
        total: 2,
        upToDate: 0,
        installing: ["two"],
        waiting: [{ runner: "one", tasks: 2 }],
        outOfDate: [],
        failed: [],
      },
    ]);

    const hooks = [{ name: "fmt", event: "after_edit" as const }];
    const setup = (runnerId: string, at: number) =>
      db.run((q) =>
        recordRunAgentSetupSteps(q, { runId: "run", runnerId, agent: "claude", hooks, at }),
      );
    await setup("two", 20);
    await setup("one", 21);
    expect(await db.run((q) => runAgentSetupSteps(q, "run"))).toEqual({
      runnerId: "one",
      skills: [
        { name: "lint", version: "a", status: "installed" },
        { name: "ship", version: "c", status: "pending" },
      ],
      hooks,
      recordedAt: 21,
    });
    expect(await db.run((q) => runAgentSetupSteps(q, "other"))).toBeNull();
  });
});
