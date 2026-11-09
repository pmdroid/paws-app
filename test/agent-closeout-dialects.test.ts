import { afterEach, expect, test } from "bun:test";
import {
  listAgentCloseoutSteps,
  recordAgentCloseoutSteps,
  type AgentCloseoutProgress,
} from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const finished: AgentCloseoutProgress = {
  type: "finished",
  head: "abc",
  id: "test",
  kind: "command",
  command: "bun test",
  attempt: 2,
  maxAttempts: 3,
  state: "passed",
  exitCode: 0,
  timedOut: false,
  durationMs: 12,
  stdout: "out",
  stderr: "",
  truncated: false,
  base: "base",
  clean: true,
};

forEachDialect((connect) => {
  test("Closeout progress numbers its events per run and reads them back in order", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const record = (runId: string, progress: AgentCloseoutProgress, at: number) =>
      db.transaction((q) => recordAgentCloseoutSteps(q, runId, "item", progress, at));
    const report: AgentCloseoutProgress = {
      type: "report",
      head: "abc",
      maxAttempts: null,
      checks: [
        { id: "test", kind: "command", command: "bun test", status: "pending", failedAttempts: 0 },
      ],
      blocked: null,
    };
    const started: AgentCloseoutProgress = {
      type: "started",
      head: "abc",
      id: "test",
      kind: "command",
      command: "bun test",
      attempt: 2,
      maxAttempts: 3,
    };
    await record("run-b", report, 1);
    await record("run-a", started, 2);
    await record("run-a", finished, 3);

    expect(await db.run((q) => listAgentCloseoutSteps(q, []))).toEqual([]);
    expect(await db.run((q) => listAgentCloseoutSteps(q, ["run-a", "run-b"]))).toEqual([
      { runId: "run-a", itemId: "item", sequence: 1, at: 2, progress: started },
      { runId: "run-a", itemId: "item", sequence: 2, at: 3, progress: finished },
      { runId: "run-b", itemId: "item", sequence: 1, at: 1, progress: report },
    ]);
  });
});
