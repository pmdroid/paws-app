import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { FakeClock, JOB_KIND, type Checkpoint, type StartupDecision } from "../src/core";
import {
  beginImplementRun,
  claimRun,
  enqueueJobOnce,
  getRun,
  getWorkItem,
  heartbeatInstance,
  insertQueuedItem,
  JobLoop,
  listJobs,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  registerInstance,
  RUN_TAKEOVER_JOB,
  RUN_TAKEOVER_MS,
  runOwner,
  takeOverGoneRuns,
  sqliteDb,
} from "../src/db";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;
const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 1, baseSha: "base" };

function sharedDatabase(): { path: string; open: () => Database } {
  const path = join(tempHome(), "paws.db");
  const first = openDatabase(path);
  migrate(first);
  first.close();
  return { path, open: () => openDatabase(path) };
}

async function runningItem(db: Database, id: string, owner: string, now: number): Promise<string> {
  insertQueuedItem(db, { id, sessionKey: `${id}-session`, now });
  const { run } = beginImplementRun(db, id, now, checkpoint);
  await claimRun(sqliteDb(db), run.id, owner);
  return run.id;
}

function resumeJobs(db: Database, itemId: string) {
  return listJobs(db).filter(
    (job) =>
      job.queue === JOB_KIND.resume && (job.payload as { itemId?: string }).itemId === itemId,
  );
}

describe("run ownership", () => {
  test("a starting instance leaves a live instance's run alone and recovers an unowned one", async () => {
    const shared = sharedDatabase();
    const a = shared.open();
    const b = shared.open();
    try {
      const acme = await registerInstance(sqliteDb(a), {
        role: "all",
        host: "acme-a",
        version: null,
        now: 0,
      });
      const ownedRun = await runningItem(a, "acme-1", acme.id, 0);
      insertQueuedItem(a, { id: "acme-2", sessionKey: "acme-2-session", now: 0 });
      beginImplementRun(a, "acme-2", 0, checkpoint);

      const other = await registerInstance(sqliteDb(b), {
        role: "all",
        host: "acme-b",
        version: null,
        now: 1_000,
      });
      expect(recoverOnStartup(b, 1_000, undefined, other.id)).toEqual([
        { type: "resume", freshSession: true, checkpoint },
      ]);
      expect(getWorkItem(b, "acme-1")).toMatchObject({ state: "running", recoveryAttempts: 0 });
      expect(resumeJobs(b, "acme-1")).toEqual([]);
      expect(runOwner(b, ownedRun)).toBe(acme.id);
      expect(getWorkItem(b, "acme-2")).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
      expect(runOwner(b, getWorkItem(b, "acme-2")!.currentRunId!)).toBe(other.id);
    } finally {
      b.close();
      a.close();
    }
  });

  test("a killed instance's run moves to one live instance within 90 s, once", async () => {
    const shared = sharedDatabase();
    const a = shared.open();
    const b = shared.open();
    const c = shared.open();
    const clock = new FakeClock(0);
    try {
      const acme = await registerInstance(sqliteDb(a), {
        role: "all",
        host: "acme-a",
        version: null,
        now: 0,
      });
      const runId = await runningItem(a, "acme-1", acme.id, 0);
      const live = [
        {
          db: b,
          id: (
            await registerInstance(sqliteDb(b), {
              role: "all",
              host: "acme-b",
              version: null,
              now: 0,
            })
          ).id,
        },
        {
          db: c,
          id: (
            await registerInstance(sqliteDb(c), {
              role: "all",
              host: "acme-c",
              version: null,
              now: 0,
            })
          ).id,
        },
      ];
      const decisions: { by: string; decision: StartupDecision }[] = [];
      const loops = live.map(({ db, id }) => {
        const loop = new JobLoop(db, clock, { workerId: id });
        loop.register(RUN_TAKEOVER_JOB, () => {
          for (const decision of takeOverGoneRuns(db, id, clock.now()))
            decisions.push({ by: id, decision });
        });
        enqueueJobOnce(db, {
          queue: RUN_TAKEOVER_JOB,
          jobKey: RUN_TAKEOVER_JOB,
          recurringEveryMs: RUN_TAKEOVER_MS,
          now: clock.now(),
        });
        return loop;
      });

      let takenAt: number | null = null;
      while (clock.now() <= 120_000) {
        for (const [index, loop] of loops.entries()) {
          await heartbeatInstance(sqliteDb(live[index]!.db), live[index]!.id, clock.now());
          await loop.tick([RUN_TAKEOVER_JOB]);
        }
        if (takenAt === null && decisions.length > 0) takenAt = clock.now();
        clock.advance(5_000);
      }

      expect(takenAt).not.toBeNull();
      expect(takenAt!).toBeLessThanOrEqual(90_000);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.decision).toEqual({ type: "resume", freshSession: true, checkpoint });
      expect(runOwner(b, runId)).toBe(decisions[0]!.by);
      expect(getWorkItem(b, "acme-1")).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
      expect(resumeJobs(b, "acme-1")).toHaveLength(1);
    } finally {
      c.close();
      b.close();
      a.close();
    }
  });

  test("an earlier process on this host whose pid is gone is taken over without waiting", async () => {
    const shared = sharedDatabase();
    const db = shared.open();
    try {
      const exited = Bun.spawnSync(["true"]).pid;
      const crashed = await registerInstance(sqliteDb(db), {
        role: "all",
        host: "acme",
        version: null,
        now: 0,
        pid: exited,
      });
      const runId = await runningItem(db, "acme-1", crashed.id, 0);
      const restarted = await registerInstance(sqliteDb(db), {
        role: "all",
        host: "acme",
        version: null,
        now: 1_000,
        pid: process.pid,
      });
      expect(recoverOnStartup(db, 1_000, undefined, restarted.id)).toEqual([
        { type: "resume", freshSession: true, checkpoint },
      ]);
      expect(runOwner(db, runId)).toBe(restarted.id);
    } finally {
      db.close();
    }
  });

  test("a clean stop releases only the stopping instance's runs", async () => {
    const shared = sharedDatabase();
    const a = shared.open();
    const b = shared.open();
    try {
      const acme = await registerInstance(sqliteDb(a), {
        role: "all",
        host: "acme-a",
        version: null,
        now: 0,
      });
      const other = await registerInstance(sqliteDb(b), {
        role: "all",
        host: "acme-b",
        version: null,
        now: 0,
      });
      const mine = await runningItem(a, "acme-1", acme.id, 0);
      const theirs = await runningItem(b, "acme-2", other.id, 0);

      prepareShutdown(a, 1_000, undefined, acme.id);

      expect(getRun(a, mine)?.status).toBe("lost");
      expect(getWorkItem(a, "acme-1")?.state).toBe("recovering");
      expect(getRun(a, theirs)?.status).toBe("active");
      expect(getWorkItem(a, "acme-2")?.state).toBe("running");
    } finally {
      b.close();
      a.close();
    }
  });
});

function spawnPaws(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
  };
  for (const key of Object.keys(env))
    if (key.startsWith("LINEAR_") || key === "PAWS_EXECUTION" || key === "PAWS_PUBLIC_URL")
      delete env[key];
  return Bun.spawn(["bun", "src/index.ts"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
}

async function readyInstance(proc: ReturnType<typeof spawnPaws>): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = /paws ready · (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (match) {
      reader.releaseLock();
      const health = (await (await fetch(`${match[1]}/health`)).json()) as { instance: string };
      return health.instance;
    }
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  throw new Error(`Paws did not print ready: ${text}`);
}

describe("run ownership across two Paws processes", () => {
  test("B leaves A's run alone at start, and A's clean stop releases only A's run", async () => {
    const home = tempHome();
    const first = spawnPaws(home);
    let second: ReturnType<typeof spawnPaws> | null = null;
    const db = openDatabase(join(home, "paws.db"));
    try {
      const a = await readyInstance(first);
      const aRun = await runningItem(db, "acme-1", a, Date.now());

      second = spawnPaws(home);
      const b = await readyInstance(second);
      expect(getWorkItem(db, "acme-1")).toMatchObject({ state: "running", recoveryAttempts: 0 });
      expect(resumeJobs(db, "acme-1")).toEqual([]);
      expect(runOwner(db, aRun)).toBe(a);
      const bRun = await runningItem(db, "acme-2", b, Date.now());

      first.kill("SIGTERM");
      expect(await first.exited).toBe(0);

      expect(getRun(db, aRun)?.status).toBe("lost");
      expect(getWorkItem(db, "acme-1")?.state).toBe("recovering");
      expect(getRun(db, bRun)?.status).toBe("active");
      expect(getWorkItem(db, "acme-2")?.state).toBe("running");
    } finally {
      first.kill("SIGKILL");
      second?.kill("SIGKILL");
      await second?.exited;
      db.close();
    }
  }, 40_000);
});
