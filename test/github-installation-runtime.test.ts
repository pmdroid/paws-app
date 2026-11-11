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
  sqliteDb,
} from "../src/db";
import { createFakeTracker, parseAgentEvent } from "../src/linear";
import { FakeGitHubIntegration, attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion, getQuestion } from "../src/questions";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";

const turns = (db: ReturnType<typeof tempDb>) =>
  db.query<{ state: string }, []>("SELECT state FROM linear_turn ORDER BY rowid").all();

async function fixture(launch?: AgentLaunch) {
  const db = tempDb();
  const home = tempHome();
  const clock = new FakeClock(1_000);
  const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  await ensureLinearSession(sqliteDb(db), {
    sessionId: "session",
    issueId: "ENG-1",
    now: clock.now(),
  });
  await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId, {
    actorId: "linear-owner",
  });
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const host = new FakeGitHubIntegration();
  host.installed = false;
  host.admins = ["linear-admin"];
  const tracker = createFakeTracker();
  const orchestrator = attachOrchestrator({
    store: sqliteDb(db),
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    pawsRoot: home,
    clock,
    tracker,
    githubInstallation: host,
    linearTaskModes: true,
    launch,
    repositories: [
      { owner: "acme", repo: "app", remoteUrl: "https://github.example/acme/app.git" },
    ],
  });
  await workspaceDispatch(db, { now: clock.now() });
  return { db, home, clock, item, jobs, outbox, host, tracker, orchestrator };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Expected owned process event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // A killed agent can remain a zombie until the container init reaps it.
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
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

test("a missing installation holds the item before Git and a reply cannot release it", async () => {
  const f = await fixture();
  try {
    await f.jobs.tick();
    const question = (await findOpenQuestion(sqliteDb(f.db), "session"))!;
    expect(question.kind).toBe("github-auth");
    expect(question.body).toContain("Waiting for a workspace admin");
    expect((await getWorkItem(sqliteDb(f.db), f.item.id))?.state).toBe("awaiting_input");
    expect(existsSync(join(f.home, "worktrees"))).toBe(false);
    expect(f.tracker.statuses).toEqual([]);
    expect(
      (await listOutbox(sqliteDb(f.db)))
        .filter((row) => row.op === "elicitation")
        .map((row) => row.payload),
    ).toEqual([
      expect.objectContaining({
        questionId: question.id,
        auth: expect.objectContaining({ userId: "linear-admin", providerName: "GitHub" }),
      }),
    ]);
    await f.orchestrator.onLinearEvent(prompt("linear-owner", "text-claim"));
    expect((await getQuestion(sqliteDb(f.db), question.id))?.status).toBe("open");
    expect((await listJobs(sqliteDb(f.db))).filter((job) => job.queue === JOB_KIND.resume)).toEqual(
      [],
    );
    expect(turns(f.db)[0]?.state).toBe("cancelled");
  } finally {
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test("the item resumes once by itself when the installation returns", async () => {
  const f = await fixture();
  try {
    await f.jobs.tick();
    const question = (await findOpenQuestion(sqliteDb(f.db), "session"))!;
    await f.orchestrator.recoverGitHubAuth();
    expect((await getWorkItem(sqliteDb(f.db), f.item.id))?.state).toBe("awaiting_input");
    f.host.installed = true;
    await f.orchestrator.recoverGitHubAuth();
    expect((await getQuestion(sqliteDb(f.db), question.id))?.answeredBy).toBe("paws");
    expect((await getWorkItem(sqliteDb(f.db), f.item.id))?.state).toBe("running");
    expect(
      (await listJobs(sqliteDb(f.db))).filter((job) => job.queue === JOB_KIND.resume),
    ).toHaveLength(1);
    await f.orchestrator.recoverGitHubAuth();
    expect(
      (await listJobs(sqliteDb(f.db))).filter((job) => job.queue === JOB_KIND.resume),
    ).toHaveLength(1);
  } finally {
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test("Stop prevents a returning installation from resuming the item", async () => {
  const f = await fixture();
  try {
    await f.jobs.tick();
    const question = (await findOpenQuestion(sqliteDb(f.db), "session"))!;
    await f.orchestrator.onLinearEvent({ ...prompt("linear-owner", "stop"), signal: "stop" });
    f.host.installed = true;
    await f.orchestrator.recoverGitHubAuth();
    expect((await getQuestion(sqliteDb(f.db), question.id))?.status).toBe("open");
    expect((await getWorkItem(sqliteDb(f.db), f.item.id))?.state).toBe("paused");
    expect((await listJobs(sqliteDb(f.db))).filter((job) => job.queue === JOB_KIND.resume)).toEqual(
      [],
    );
  } finally {
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test.each(["pending", "rejected"] as const)(
  "%s installation recovery cannot prevent another owned ACP writer from stopping",
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
    const f = await fixture(() => ({
      command: process.execPath,
      args: [wrapper, trace, script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    }));
    const linked = Promise.withResolvers<boolean>();
    const reading = Promise.withResolvers<void>();
    let released = false;
    let running: Promise<unknown> | undefined;
    let shutting: Promise<unknown> | undefined;
    try {
      await f.jobs.tick();
      f.host.check = () => {
        reading.resolve();
        return linked.promise;
      };
      const recovering = f.orchestrator.recoverGitHubAuth();
      void recovering.catch(() => undefined);
      await reading.promise;
      const writer = insertQueuedItem(f.db, { id: "ENG-2", sessionKey: "writer" });
      await applyWorkItemEvent(sqliteDb(f.db), writer.id, "dispatched");
      await saveTaskMode(sqliteDb(f.db), writer.id, "answer");
      await enqueueJobOnce(sqliteDb(f.db), {
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
      if (outcome === "rejected") linked.reject(new Error("Installation lookup unavailable"));
      else linked.resolve(true);
      released = true;
      await shutting;
      await running;
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(false);
      expect((await getWorkItem(sqliteDb(f.db), writer.id))?.state).toBe("running");
    } finally {
      if (!released) linked.resolve(true);
      await Promise.allSettled([shutting, running]);
      await f.orchestrator.shutdown();
      f.db.close();
    }
  },
);
