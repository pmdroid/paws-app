import { expect, test } from "bun:test";
import { join } from "node:path";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { ensureLinearSession, getTaskClassification, listOutbox } from "../src/db";
import { createTaskPlanner } from "../src/loop";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

function replying(text: string) {
  let runs = 0;
  const agent = async (options: RunAgentOptions): Promise<RunAgentResult> => {
    runs++;
    options.onEvent?.({
      type: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    } as never);
    return {
      role: options.role,
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
    };
  };
  return { agent, runs: () => runs };
}

async function planOnce(reply: string) {
  const home = tempHome();
  const { db, close } = await tempStore();
  await ensureLinearSession(db, { sessionId: "session" });
  const fake = replying(reply);
  const planner = createTaskPlanner({
    store: db,
    home,
    pawsRoot: join(home, "paws"),
    launch: () => {
      throw new Error("The planner must use the session agent");
    },
    agentForSession: () => fake.agent,
    profile: () => ({ agent: "codex", model: null }),
  });
  const plan = () =>
    planner.plan({ taskKey: "task", sessionId: "session", request: async () => "Fix the build." });
  return { db, close, plan, runs: fake.runs };
}

test("a classification with what it understood posts one Linear thought and stores no sentence", async () => {
  const sentence = "I understand this as a request to fix the failing build.";
  const { db, close, plan, runs } = await planOnce(
    JSON.stringify({ mode: "code", understood: sentence }),
  );
  try {
    expect(await plan()).toEqual({ mode: "code" });
    expect(await plan()).toEqual({ mode: "code" });
    expect(runs()).toBe(1);
    expect(await getTaskClassification(db, "task")).toEqual({ mode: "code" });
    const rows = await listOutbox(db, "session");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: "understood:task",
      payload: { sessionId: "session", kind: "thought", body: sentence },
    });
  } finally {
    await close();
  }
});

test("a classification without what it understood posts nothing", async () => {
  const { db, close, plan } = await planOnce(JSON.stringify({ mode: "answer" }));
  try {
    expect(await plan()).toEqual({ mode: "answer" });
    expect(await listOutbox(db, "session")).toEqual([]);
  } finally {
    await close();
  }
});
