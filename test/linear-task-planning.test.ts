import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  advanceLinearSessionGeneration,
  ensureLinearSession,
  getTaskClassification,
  migrate,
  openDatabase,
  resolveTaskClassification,
  saveTaskClassification,
} from "../src/db";
import { createTaskPlanner, type AgentLaunch } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

function fixture() {
  const db = tempDb();
  const home = tempHome();
  const pawsRoot = join(home, "paws");
  mkdirSync(pawsRoot);
  ensureLinearSession(db, { sessionId: "session" });
  const traces: string[] = [];
  const launch: AgentLaunch = () => {
    const first = traces.length === 0;
    const script = join(home, `${traces.length}.script.json`);
    const trace = join(home, `${traces.length}.result.json`);
    traces.push(trace);
    writeFileSync(
      script,
      JSON.stringify({
        steps: first
          ? [{ type: "hang" }]
          : [
              {
                type: "update",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: '{"mode":"answer"}' },
                },
              },
              { type: "end" },
            ],
      }),
    );
    return {
      command: process.execPath,
      args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    };
  };
  const planner = createTaskPlanner({
    db,
    home,
    pawsRoot,
    launch,
    profile: () => ({ agent: "codex", model: null }),
  });
  const plan = (taskKey: string) =>
    planner.plan({ taskKey, sessionId: "session", request: async () => "Explain the code." });
  const waitForFirst = async () => {
    for (let i = 0; i < 1000; i++) {
      try {
        if (JSON.parse(readFileSync(traces[0]!, "utf8")).methods.includes("session/prompt")) return;
      } catch {}
      await Bun.sleep(1);
    }
    throw new Error("The classifier did not start");
  };
  return { db, planner, traces, plan, waitForFirst };
}

test("concurrent replacement planning joins one classifier and durably reuses its result", async () => {
  const f = fixture();
  try {
    const first = f.plan("first").catch((error: unknown) => error);
    await f.waitForFirst();
    advanceLinearSessionGeneration(f.db, "session");
    expect(await Promise.all([f.plan("replacement"), f.plan("replacement")])).toEqual([
      { mode: "answer" },
      { mode: "answer" },
    ]);
    expect(await first).toBeInstanceOf(Error);
    expect(f.traces).toHaveLength(2);
    expect(getTaskClassification(f.db, "first")).toBeNull();
    expect(await f.plan("replacement")).toEqual({ mode: "answer" });
    expect(f.traces).toHaveLength(2);
  } finally {
    await f.planner.stop();
    f.db.close();
  }
}, 15000);

test("Stop joins the active process and rejects a replacement waiting for its cleanup", async () => {
  const f = fixture();
  try {
    const first = f.plan("first").catch((error: unknown) => error);
    await f.waitForFirst();
    advanceLinearSessionGeneration(f.db, "session");
    const next = f.plan("replacement").catch((error: unknown) => error);
    await f.planner.stop("session");
    expect(await first).toBeInstanceOf(Error);
    expect(await next).toBeInstanceOf(Error);
    expect(f.traces).toHaveLength(1);
    expect(getTaskClassification(f.db, "first")).toBeNull();
    expect(getTaskClassification(f.db, "replacement")).toBeNull();
  } finally {
    await f.planner.stop();
    f.db.close();
  }
}, 15000);

test("a clarification resolution preserves its child-task redirect and guidance across restart", () => {
  const path = join(tempHome(), "planning.db");
  const db = openDatabase(path);
  migrate(db);
  saveTaskClassification(db, "request", { mode: "clarify", question: "Which outcome?" });
  saveTaskClassification(db, "request", { mode: "artifact" });
  expect(getTaskClassification(db, "request")?.mode).toBe("clarify");
  resolveTaskClassification(db, {
    taskKey: "request",
    itemId: "placeholder",
    context: "Change both children.",
  });
  db.close();
  const reopened = openDatabase(path);
  try {
    migrate(reopened);
    expect(getTaskClassification(reopened, "request")).toEqual({
      mode: "code",
      redirect: { taskKey: "resolved:request", itemId: "placeholder" },
    });
    expect(getTaskClassification(reopened, "resolved:request")).toEqual({
      mode: "code",
      context: "Change both children.",
      sourceItemId: "placeholder",
    });
  } finally {
    reopened.close();
  }
});
