import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  applyWorkItemEvent,
  enqueueJobOnce,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  saveTaskMode,
} from "../src/db";
import { createFakeTracker, parseAgentEvent } from "../src/linear";
import { FakeHostGitHubAuth, attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion, getQuestion } from "../src/questions";
import { tempDb, tempHome } from "./helpers";

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const turns = (db: ReturnType<typeof tempDb>) =>
  db.query<{ state: string }, []>("SELECT state FROM linear_turn ORDER BY rowid").all();

function fixture(launch?: AgentLaunch) {
  const db = tempDb();
  const home = tempHome();
  const clock = new FakeClock(1_000);
  const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  ensureLinearSession(db, { sessionId: "session", issueId: "ENG-1", now: clock.now() });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "linear-owner" });
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const host = new FakeHostGitHubAuth();
  const tracker = createFakeTracker();
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: home,
    clock,
    tracker,
    githubAuth: host,
    linearTaskModes: true,
    launch,
    repository: { owner: "acme", repo: "app", remoteUrl: "https://github.example/acme/app.git" },
  });
  enqueueJobOnce(db, {
    queue: JOB_KIND.start,
    jobKey: "start",
    payload: { itemId: item.id },
    now: clock.now(),
  });
  return { db, home, clock, item, jobs, outbox, host, tracker, orchestrator };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Expected owned process event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function prompt(userId: string, id: string, body = "I signed in") {
  return parseAgentEvent(
    JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      webhookTimestamp: 2_000,
      agentSession: { id: "session", issue: { id: "ENG-1" } },
      agentActivity: {
        id,
        userId,
        createdAt: new Date(2_000).toISOString(),
        content: { type: "prompt", body },
      },
    }),
    `delivery:${id}`,
    2_000,
  )!;
}

test("expired host credentials block before Git or workflow and text cannot authenticate", async () => {
  const f = fixture();
  try {
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("awaiting_input");
    expect(existsSync(join(f.home, "worktrees"))).toBe(false);
    expect(f.tracker.statuses).toEqual([]);
    expect(listOutbox(f.db).find((row) => row.op === "elicitation")?.payload).toMatchObject({
      questionId: question.id,
      auth: { userId: "linear-owner", providerName: "GitHub" },
    });
    await f.orchestrator.onLinearEvent(prompt("linear-owner", "text-claim"));
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
    expect(turns(f.db)[0]?.state).toBe("cancelled");
    expect(f.host.account).toBeNull();
  } finally {
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test("only the task owner retries, and verified native completion resumes once", async () => {
  const f = fixture();
  try {
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    f.host.challenges[0]!.fail(new Error("Provider unavailable"));
    await settled();
    await f.orchestrator.onLinearEvent(prompt("another-user", "wrong-owner", "retry"));
    expect(f.host.challenges).toHaveLength(1);
    await f.orchestrator.onLinearEvent(prompt("linear-owner", "retry", "retry"));
    expect(f.host.challenges).toHaveLength(2);
    expect(getQuestion(f.db, question.id)?.status).toBe("open");
    expect(turns(f.db).map((turn) => turn.state)).toEqual(["cancelled", "applied"]);
    f.host.challenges[1]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(getQuestion(f.db, question.id)?.answeredBy).toBe("linear-owner");
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("running");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
    await f.orchestrator.onLinearEvent(prompt("linear-owner", "retry", "retry"));
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
  } finally {
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test("Stop through the question handler prevents a late native login from resuming", async () => {
  const f = fixture();
  try {
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    await f.orchestrator.onLinearEvent({ ...prompt("linear-owner", "stop"), signal: "stop" });
    f.host.challenges[0]!.complete({ id: 7, login: "owner" });
    await settled();
    expect(getQuestion(f.db, question.id)?.status).toBe("cancelled");
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
    expect(f.host.account).toBeNull();
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
  } finally {
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test.each(["pending", "rejected"] as const)(
  "%s auth recovery cannot prevent another owned ACP writer from stopping",
  async (outcome) => {
    const home = tempHome();
    const trace = join(home, "trace.json");
    const script = join(home, "hang.json");
    const pidFile = join(home, "pid");
    const wrapper = join(home, "fake-agent.ts");
    writeFileSync(script, JSON.stringify({ steps: [{ type: "hang" }] }));
    writeFileSync(
      wrapper,
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await import(${JSON.stringify(resolvePath(import.meta.dir, "../src/acp/testing/fake-agent.ts"))});`,
    );
    const f = fixture(() => ({
      command: process.execPath,
      args: [wrapper, trace, script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    }));
    const linked = Promise.withResolvers<number | null>();
    const reading = Promise.withResolvers<void>();
    let released = false;
    let running: Promise<unknown> | undefined;
    let shutting: Promise<unknown> | undefined;
    try {
      await f.jobs.tick();
      f.host.linkedAccount = () => {
        reading.resolve();
        return linked.promise;
      };
      const recovering = f.orchestrator.recoverGitHubAuth();
      void recovering.catch(() => undefined);
      await reading.promise;
      const writer = insertQueuedItem(f.db, { id: "ENG-2", sessionKey: "writer" });
      applyWorkItemEvent(f.db, writer.id, "dispatched");
      saveTaskMode(f.db, writer.id, "answer");
      enqueueJobOnce(f.db, {
        queue: JOB_KIND.resume,
        jobKey: "writer",
        payload: { itemId: writer.id },
        now: f.clock.now(),
      });
      running = f.jobs.tick();
      await until(
        () => existsSync(trace) && JSON.parse(readFileSync(trace, "utf8")).prompts?.length > 0,
      );
      shutting = f.orchestrator.shutdown();
      void shutting.catch(() => undefined);
      await until(() => JSON.parse(readFileSync(trace, "utf8")).methods.includes("session/cancel"));
      if (outcome === "rejected") linked.reject(new Error("Account store unavailable"));
      else linked.resolve(7);
      released = true;
      if (outcome === "rejected")
        await expect(shutting).rejects.toThrow("Account store unavailable");
      else await shutting;
      await running;
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(getWorkItem(f.db, writer.id)?.state).toBe("running");
    } finally {
      if (!released) linked.resolve(7);
      await Promise.allSettled([shutting, running]);
      await f.orchestrator.shutdown();
      f.db.close();
    }
  },
);
