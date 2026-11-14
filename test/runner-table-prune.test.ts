import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  lastRunCommandAccountSteps,
  lastRunResultSteps,
  runnerResultPayloadSteps,
  type Db,
  type Q,
} from "../src/db";
import { pruneRunnerEvents, pruneRunnerTables } from "../src/runner-work";
import {
  forEachDialect,
  insertRunnerBindingSteps,
  json,
  seed,
  withoutForeignKeys,
} from "./dialects";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const ago = (days: number) => NOW - days * DAY;

const NOTHING = {
  runner_question_answer: 0,
  runner_follow_up: 0,
  runner_result: 0,
  runner_health_result: 0,
  runner_command: 0,
  runner_helper: 0,
};

function keys<T>(db: Db, read: (q: Q) => PromiseLike<T[]>, key: (row: T) => string | number) {
  return db.run((q) => q.all(read(q))).then((rows) => rows.map(key).sort());
}

function fixtures(db: Db) {
  const run = (
    id: string,
    endedDaysAgo: number | null,
    options: { generation?: number; commandId?: string; teardownConfirmed?: boolean } = {},
  ) =>
    seed(
      db,
      (q) =>
        q.orm.insert(q.t.run).values({
          id,
          itemId: `item-${id}`,
          kind: "agent",
          agent: "codex",
          status: endedDaysAgo === null ? "active" : "ended",
          createdAt: 0,
          updatedAt: endedDaysAgo === null ? NOW : ago(endedDaysAgo),
        }),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: id,
          runnerId: "runner",
          workspaceId: "workspace",
          generation: options.generation ?? 1,
          runnerFence: 0,
          commandId: options.commandId ?? `current-${id}`,
          leaseUntil: 0,
          endedAt: endedDaysAgo === null ? null : ago(endedDaysAgo),
          teardownConfirmedAt: options.teardownConfirmed === false ? null : 0,
        }),
    );
  const command = (
    id: string,
    runId: string | null,
    options: {
      kind?: string;
      generation?: number;
      acknowledged?: boolean;
      expiresAt?: number;
    } = {},
  ) =>
    seed(db, (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id,
        runnerId: "runner",
        runId,
        generation: runId === null ? null : (options.generation ?? 1),
        kind: options.kind ?? "run",
        envelope: json(db, { id }),
        expiresAt: options.expiresAt ?? 0,
        acknowledgedAt: options.acknowledged === false ? null : 0,
      }),
    );
  const result = (runId: string, generation: number, commandId: string, receivedDaysAgo: number) =>
    seed(db, (q) =>
      q.orm.insert(q.t.runnerResult).values({
        runId,
        generation,
        commandId,
        payload: json(db, { generation }),
        receivedAt: ago(receivedDaysAgo),
      }),
    );
  const commands = () =>
    keys(
      db,
      (q) => q.orm.select({ id: q.t.runnerCommand.id }).from(q.t.runnerCommand),
      (row) => row.id,
    );
  return { run, command, result, commands };
}

forEachDialect((open) => {
  test("the prune deletes answers and follow-ups a day after their run ends", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const { run } = fixtures(db);
    await run("old", 2);
    await run("recent", 0.5);
    await run("live", null);
    for (const runId of ["old", "recent", "live"])
      await seed(
        db,
        (q) =>
          q.orm.insert(q.t.runnerEvent).values(
            [1, 2].map((sequence) => ({
              runId,
              generation: 1,
              sequence,
              payload: json(db, {}),
              receivedAt: 0,
              type: "question",
            })),
          ),
        (q) =>
          q.orm.insert(q.t.runnerQuestionAnswer).values({
            runId,
            generation: 1,
            sequence: 1,
            answer: "yes",
            createdAt: 0,
          }),
        (q) =>
          q.orm.insert(q.t.runnerFollowUp).values(
            [1, 2].map((sequence) => ({
              runId,
              generation: 1,
              sequence,
              body: "more",
              createdAt: 0,
            })),
          ),
      );
    const left = async () => ({
      answers: await keys(
        db,
        (q) =>
          q.orm.select({ runId: q.t.runnerQuestionAnswer.runId }).from(q.t.runnerQuestionAnswer),
        (row) => row.runId,
      ),
      followUps: await keys(
        db,
        (q) => q.orm.select({ runId: q.t.runnerFollowUp.runId }).from(q.t.runnerFollowUp),
        (row) => row.runId,
      ),
      events: await keys(
        db,
        (q) =>
          q.orm
            .select({ runId: q.t.runnerEvent.runId, sequence: q.t.runnerEvent.sequence })
            .from(q.t.runnerEvent),
        (row) => `${row.runId}:${row.sequence}`,
      ),
    });

    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      runner_question_answer: 1,
      runner_follow_up: 2,
    });
    expect(await left()).toEqual({
      answers: ["live", "recent"],
      followUps: ["live", "live", "recent", "recent"],
      events: ["live:1", "live:2", "old:2", "recent:1", "recent:2"],
    });
    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual(NOTHING);
    await close();
  });

  test("a run whose answers were pruned still has its events pruned after a week", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const { run } = fixtures(db);
    await run("answered", 8);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runnerEvent).values(
          [1, 2].map((sequence) => ({
            runId: "answered",
            generation: 1,
            sequence,
            payload: json(db, {}),
            receivedAt: 0,
            type: sequence === 1 ? "question" : "progress",
          })),
        ),
      (q) =>
        q.orm.insert(q.t.runnerQuestionAnswer).values({
          runId: "answered",
          generation: 1,
          sequence: 1,
          answer: "yes",
          createdAt: 0,
        }),
    );

    await pruneRunnerTables({ store: db, now: NOW });
    expect(await pruneRunnerEvents({ store: db, now: NOW })).toEqual({ deleted: 1 });
    await close();
  });

  test("the prune deletes superseded results a week old and keeps the latest per command kind", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const { run, command, result } = fixtures(db);
    await run("run", 10, { generation: 4, commandId: "run-4" });
    await command("run-1", "run", { generation: 1 });
    await command("run-2", "run", { generation: 2 });
    await command("review-3", "run", { kind: "review", generation: 3 });
    await command("run-4", "run", { generation: 4 });
    await result("run", 1, "run-1", 9);
    await result("run", 2, "run-2", 6);
    await result("run", 3, "review-3", 9);
    await result("run", 4, "run-4", 5);
    const generations = () =>
      keys(
        db,
        (q) => q.orm.select({ generation: q.t.runnerResult.generation }).from(q.t.runnerResult),
        (row) => row.generation,
      );

    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      runner_result: 1,
    });
    expect(await generations()).toEqual([2, 3, 4]);
    expect(await db.run((q) => runnerResultPayloadSteps(q, "run", 4))).not.toBeNull();
    expect(JSON.parse((await db.run((q) => lastRunResultSteps(q, "item-run")))!.payload)).toEqual({
      generation: 4,
    });
    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual(NOTHING);
    await close();
  });

  test("the prune deletes acknowledged commands a week after their work ends", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const { run, command, commands } = fixtures(db);
    await run("old", 8, { generation: 2, commandId: "old-current" });
    await command("old-run-1a", "old", { generation: 1 });
    await command("old-run-1b", "old", { generation: 1 });
    await command("old-cancel", "old", { kind: "cancel", generation: 1 });
    await command("old-checkpoint", "old", { kind: "checkpoint", generation: 2 });
    await command("old-current", "old", { generation: 2 });
    await command("old-transcript", "old", { kind: "handover", generation: 2 });
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerTranscript).values({
        runId: "old",
        generation: 2,
        commandId: "old-transcript",
        workspaceId: "workspace",
        executionId: "execution",
      }),
    );
    await run("recent", 6);
    await command("recent-run", "recent");
    await command("recent-checkpoint", "recent", { kind: "checkpoint" });
    await run("live", null);
    await command("live-checkpoint", "live", { kind: "checkpoint" });
    await run("waiting", 30);
    await command("waiting-checkpoint", "waiting", { kind: "checkpoint" });
    await command("waiting-cancel", "waiting", { kind: "cancel", acknowledged: false });
    await run("torn", 30, { teardownConfirmed: false });
    await command("torn-cancel", "torn", { kind: "cancel" });
    await command("torn-checkpoint", "torn", { kind: "checkpoint" });
    await command("probe", null, { kind: "probe" });
    const before = await commands();

    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      runner_command: 4,
    });
    expect(await commands()).toEqual(
      before.filter(
        (id) => !["old-run-1a", "old-cancel", "old-checkpoint", "torn-checkpoint"].includes(id),
      ),
    );
    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual(NOTHING);
    await close();
  });

  test("session restore still finds the account of a generation's last run command", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const { run, command } = fixtures(db);
    await run("old", 8, { generation: 2, commandId: "current" });
    await command("first", "old", { generation: 1 });
    await command("second", "old", { generation: 1 });
    await command("current", "old", { generation: 2 });
    await db.run((q) => insertRunnerBindingSteps(q));
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCommandAccount).values(
        ["second"].map((commandId) => ({
          commandId,
          workspaceId: "acme",
          runnerId: "box",
          agent: "codex",
          accountId: "account",
          bindingId: "binding",
          named: 1,
          recordedAt: 0,
        })),
      ),
    );

    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      runner_command: 1,
    });
    expect(await db.run((q) => lastRunCommandAccountSteps(q, "old", 1))).toEqual({
      accountId: "account",
      named: 1,
    });
    await close();
  });

  test("the prune keeps each runner's latest 50 health results", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const { command } = fixtures(db);
    const health = async (runnerId: string, count: number, expiresAt = 0) => {
      for (let index = 0; index < count; index++) {
        const id = `${runnerId}-${String(index).padStart(3, "0")}`;
        await seed(
          db,
          (q) =>
            q.orm.insert(q.t.runnerCommand).values({
              id,
              runnerId,
              kind: "probe",
              envelope: json(db, { id }),
              expiresAt,
              acknowledgedAt: 0,
            }),
          (q) =>
            q.orm
              .insert(q.t.runnerHealthResult)
              .values({ commandId: id, runnerId, resultJson: "{}", receivedAt: index }),
        );
      }
    };
    await health("busy", 53);
    await health("quiet", 10);
    await health("fresh", 52, NOW + DAY);
    await command("pending-probe", null, { kind: "probe" });
    await seed(
      db,
      (q) =>
        q.orm
          .update(q.t.runnerHealthResult)
          .set({ receivedAt: -1 })
          .where(eq(q.t.runnerHealthResult.commandId, "busy-001")),
      (q) =>
        q.orm.insert(q.t.agentModelProbe).values({
          commandId: "busy-001",
          runnerId: "busy",
          userId: "user",
          agent: "codex",
          model: "m",
          requestedAt: 0,
        }),
    );
    const left = (runnerId: string) =>
      keys(
        db,
        (q) =>
          q.orm
            .select({ id: q.t.runnerHealthResult.commandId })
            .from(q.t.runnerHealthResult)
            .where(eq(q.t.runnerHealthResult.runnerId, runnerId)),
        (row) => row.id,
      );

    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      runner_health_result: 2,
    });
    expect((await left("busy")).slice(0, 3)).toEqual(["busy-001", "busy-003", "busy-004"]);
    expect(await left("busy")).toHaveLength(51);
    expect(await left("quiet")).toHaveLength(10);
    expect(await left("fresh")).toHaveLength(52);
    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual(NOTHING);
    await close();
  });

  test("the prune deletes helpers a week after they end", async () => {
    const { db, close } = await open();
    await withoutForeignKeys(db);
    const helper = (id: string, endedDaysAgo: number | null, expiresDaysAgo = 8) =>
      seed(db, (q) =>
        q.orm.insert(q.t.runnerHelper).values({
          id,
          runnerId: "runner",
          workspaceId: "workspace",
          sessionId: "session",
          sessionGeneration: 1,
          runnerFence: 0,
          envelope: json(db, { id }),
          expiresAt: ago(expiresDaysAgo),
          endedAt: endedDaysAgo === null ? null : ago(endedDaysAgo),
        }),
      );
    await helper("old", 8);
    await helper("recent", 6);
    await helper("open", null);
    await helper("unexpired", 8, -1);

    expect(await pruneRunnerTables({ store: db, now: NOW })).toEqual({
      ...NOTHING,
      runner_helper: 1,
    });
    expect(
      await keys(
        db,
        (q) => q.orm.select({ id: q.t.runnerHelper.id }).from(q.t.runnerHelper),
        (row) => row.id,
      ),
    ).toEqual(["open", "recent", "unexpired"]);
    await close();
  });
});
