import { expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FakeScript } from "../src/acp/testing/script";
import { FakeClock } from "../src/core";
import { JobLoop, listOutbox, migrate, openDatabase, OutboxDispatcher } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, KEEPALIVE_MS, LINEAR_STALE_MS } from "../src/loop";
import { emptyReview, repoLayout, stateOf } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { tickWithRestarts } from "./helpers";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

function event(action: "created" | "prompted", signal: string | null): AcceptedLinearEvent {
  return {
    dedupeKey: `${action}:${signal ?? "keepalive"}`,
    deliveryId: null,
    source: "webhook",
    action,
    sessionId: "ses_1",
    issueId: action === "created" ? "iss-keep" : null,
    activityId: action === "prompted" ? "act-1" : null,
    actorId: action === "prompted" ? "human-1" : null,
    body: null,
    signal,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

function waitFor(file: string): FakeScript["steps"][number] {
  return {
    type: "terminal",
    command: "bun",
    args: [
      "-e",
      `while (!(await Bun.file(${JSON.stringify(file)}).exists())) await Bun.sleep(10);`,
    ],
  };
}

test("keepalive stays under Linear's stale window at 25 minutes", () => {
  expect(KEEPALIVE_MS).toBe(25 * 60 * 1000);
  expect(KEEPALIVE_MS).toBeLessThan(LINEAR_STALE_MS);
});

test("the running keepalive names the agent's current plan step, never a bare Working on", async () => {
  const layout = await repoLayout("paws-keepalive-");
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const clock = new FakeClock(Date.now());
  const tracker = createFakeTracker([
    {
      linearIssueId: "iss-keep",
      identifier: "ENG-25",
      title: "Rank runners",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  let planned = "";
  let release = "";
  const ticks: (() => void)[] = [];
  const interval = globalThis.setInterval;
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    delay?: number,
  ) => {
    if (delay === KEEPALIVE_MS) ticks.push(handler);
    return interval(handler, delay);
  }) as typeof setInterval);
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    launch(input) {
      const scriptPath = path.join(layout.root, `keep-${input.purpose}-${input.role}.json`);
      const model = input.role === "reviewer" ? "test-codex-model" : "test-claude-model";
      if (input.purpose !== "implement") {
        const script = input.purpose === "review" ? emptyReview() : { steps: [{ type: "end" }] };
        writeFileSync(scriptPath, JSON.stringify({ ...script, model }));
        return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
      }
      planned = path.join(input.worktree, "planned");
      release = path.join(input.worktree, "release");
      const script: FakeScript = {
        model,
        steps: [
          { type: "post_update", text: "Found the cause in the scheduler." },
          waitFor(planned),
          {
            type: "update",
            update: {
              sessionUpdate: "plan",
              entries: [
                { content: "Read the scheduler", priority: "medium", status: "completed" },
                { content: "Add coverage", priority: "medium", status: "completed" },
                { content: "rank runners by load share", priority: "high", status: "in_progress" },
                { content: "Wire the setting", priority: "medium", status: "pending" },
                { content: "Document it", priority: "low", status: "pending" },
              ],
            },
          },
          waitFor(release),
          { type: "end" },
        ],
      };
      writeFileSync(scriptPath, JSON.stringify(script));
      return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
    },
  });
  const thoughts = () =>
    tracker.progress.filter((update) => update.kind === "thought").map((update) => update.body);
  const hasPlan = () =>
    listOutbox(db).some(
      (row) =>
        row.op === "linear.session.plan" &&
        JSON.stringify(row.payload).includes("rank runners by load share"),
    );
  let running: Promise<unknown> | undefined;
  try {
    await orchestrator.onLinearEvent(event("created", null));
    running = tickWithRestarts(jobs, orchestrator, db);
    for (let i = 0; i < 1_000 && ticks.length === 0; i++) await Bun.sleep(10);
    expect(ticks).toHaveLength(1);

    // Before the agent has a plan, the keepalive repeats its last post_update line.
    for (let i = 0; i < 1_000 && !thoughts().includes("Found the cause in the scheduler."); i++)
      await Bun.sleep(10);
    clock.advance(KEEPALIVE_MS);
    ticks[0]!();
    await outbox.idle();
    expect(thoughts().slice(-2)).toEqual([
      "Found the cause in the scheduler.",
      "Found the cause in the scheduler.",
    ]);

    writeFileSync(planned, "go");
    for (let i = 0; i < 1_000 && !hasPlan(); i++) await Bun.sleep(10);
    expect(hasPlan()).toBe(true);
    clock.advance(KEEPALIVE_MS);
    ticks[0]!();
    await outbox.idle();
    expect(thoughts().at(-1)).toBe("Step 3 of 5: rank runners by load share.");
    expect(thoughts()).not.toContain("Working on ENG-25.");
    const keepalives = listOutbox(db).filter(
      (row) => row.op === "activity" && row.idempotencyKey.includes(":keep:"),
    );
    expect(keepalives.map((row) => (row.payload as { ephemeral?: boolean }).ephemeral)).toEqual([
      true,
      true,
    ]);

    await orchestrator.onLinearEvent(event("prompted", "stop"));
    writeFileSync(release, "go");
    await running;
    expect(stateOf(db, "ENG-25")).toBe("cancelled");
  } finally {
    for (const file of [planned, release])
      if (file !== "" && !existsSync(file)) writeFileSync(file, "go");
    await running;
    await orchestrator.shutdown();
    intervalSpy.mockRestore();
    db.close();
    await layout.cleanup();
  }
}, 20_000);
