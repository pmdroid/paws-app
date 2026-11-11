import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  claimNextJob,
  enqueueJob,
  getJob,
  getPushOutage,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import { PushOutageError } from "../github";
import { findOpenQuestion, getQuestion } from "../questions";
import {
  PUSH_OUTAGE_QUESTION_MS,
  askAboutPushOutage,
  holdPush,
  parkForPushOutage,
  pushRefused,
  pushWorked,
} from "./push-outage";

const REPOSITORY = "pmdroid/paws-app";
const DENIED =
  "remote: Permission to pmdroid/paws-app.git denied to paws-helper[bot].\nfatal: unable to access 'https://github.com/pmdroid/paws-app.git/': The requested URL returned error: 403";
const MINUTE = 60_000;

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** Three items waiting to merge, each with a merge job in queue order. */
function lane() {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  const jobs = [];
  for (const [index, name] of ["a", "b", "c"].entries()) {
    insertQueuedItem(db, { id: `item-${name}`, sessionKey: `ses-${name}`, now: 0 });
    beginImplementRun(db, `item-${name}`, 1);
    jobs.push(
      enqueueJob(db, {
        queue: JOB_KIND.merge,
        jobKey: `merge:item-${name}`,
        payload: { itemId: `item-${name}` },
        now: 10 + index,
      }),
    );
  }
  return { db, jobs: jobs as [number, number, number] };
}

function claim(db: Database, now: number) {
  return claimNextJob(db, { workerId: "worker", leaseMs: MINUTE, now, queues: [JOB_KIND.merge] });
}

/** Runs the next due merge job the way the orchestrator does with a push outage. */
async function attempt(
  db: Database,
  now: number,
  pushes: (jobId: number) => "refused" | "works",
): Promise<{ id: number; pushed: boolean; held?: boolean } | null> {
  const job = claim(db, now);
  if (!job) return null;
  try {
    await holdPush(sqliteDb(db), REPOSITORY, job.id);
    if (pushes(job.id) === "refused") throw new PushOutageError(["push"], DENIED);
    await pushWorked(sqliteDb(db), REPOSITORY, now);
    db.run("UPDATE job SET status = 'done' WHERE id = ?", [job.id]);
    return { id: job.id, pushed: true };
  } catch (error) {
    if (!(error instanceof PushOutageError)) throw error;
    const outage = await pushRefused(db, {
      repository: REPOSITORY,
      error,
      jobId: job.id,
      installationUrl: "https://github.com/settings/installations/2",
      now,
    });
    expect(await parkForPushOutage(db, job, outage!, now)).toBe("parked");
    return { id: job.id, pushed: false, held: error.held };
  }
}

describe("a push outage", () => {
  test("a denied push holds every merge push, fails nothing and asks nothing", async () => {
    const { db, jobs } = lane();
    const first = await attempt(db, 100, () => "refused");
    expect(first).toEqual({ id: jobs[0], pushed: false, held: false });
    // The jobs behind it reach their push and wait without trying it.
    expect(await attempt(db, 101, () => "works")).toEqual({
      id: jobs[1],
      pushed: false,
      held: true,
    });
    expect(await attempt(db, 102, () => "works")).toEqual({
      id: jobs[2],
      pushed: false,
      held: true,
    });

    expect(await getPushOutage(sqliteDb(db), REPOSITORY)).toMatchObject({
      startedAt: 100,
      failedProbes: 0,
      nextProbeAt: 100 + MINUTE,
      probeJobId: jobs[0],
      lastError: DENIED,
    });
    for (const id of jobs) {
      const job = getJob(db, id)!;
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(0);
      expect(job.payload).toMatchObject({
        pushOutage: REPOSITORY,
        mergeWait: { reason: "push_outage" },
      });
    }
    for (const name of ["a", "b", "c"]) {
      expect(getWorkItem(db, `item-${name}`)?.state).toBe("running");
      expect(findOpenQuestion(db, `ses-${name}`)).toBeNull();
    }
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toEqual([]);
  });

  test("one probe retries after 1, 2 and 5 minutes, then every 10 minutes", async () => {
    const { db, jobs } = lane();
    await attempt(db, 100, () => "refused");
    await attempt(db, 101, () => "works");
    await attempt(db, 102, () => "works");
    const probes: number[] = [];
    let now: number;
    for (let index = 0; index < 5; index++) {
      now = (await getPushOutage(sqliteDb(db), REPOSITORY))!.nextProbeAt;
      // Only the probe is due; the held jobs wait for the outage to end.
      expect(claim(db, now - 1)).toBeNull();
      const tried = await attempt(db, now, () => "refused");
      expect(tried).toMatchObject({ id: jobs[0], pushed: false, held: false });
      probes.push(now);
    }
    expect(probes).toEqual([1, 3, 8, 18, 28].map((minutes) => 100 + minutes * MINUTE));
    expect((await getPushOutage(sqliteDb(db), REPOSITORY))?.failedProbes).toBe(5);
  });

  test("the first push that works ends it and the held pushes run in queue order", async () => {
    const { db, jobs } = lane();
    await attempt(db, 100, () => "refused");
    await attempt(db, 101, () => "works");
    await attempt(db, 102, () => "works");
    const probeAt = (await getPushOutage(sqliteDb(db), REPOSITORY))!.nextProbeAt;
    const ran: number[] = [];
    const pushed = (id: number) => {
      ran.push(id);
      return "works" as const;
    };
    expect(await attempt(db, probeAt, pushed)).toEqual({ id: jobs[0], pushed: true });
    expect(await getPushOutage(sqliteDb(db), REPOSITORY)).toBeNull();
    expect(await attempt(db, probeAt + 1, pushed)).toEqual({ id: jobs[1], pushed: true });
    expect(await attempt(db, probeAt + 2, pushed)).toEqual({ id: jobs[2], pushed: true });
    expect(ran).toEqual(jobs);
  });

  test("a held job takes the probe over when the probe's item stopped", async () => {
    const { db, jobs } = lane();
    await attempt(db, 100, () => "refused");
    await attempt(db, 101, () => "works");
    db.run("UPDATE job SET status = 'cancelled' WHERE id = ?", [jobs[0]]);
    db.run("UPDATE job SET run_at = 0 WHERE id = ?", [jobs[1]]);
    expect(await attempt(db, 105, () => "works")).toEqual({ id: jobs[1], pushed: true });
    expect(await getPushOutage(sqliteDb(db), REPOSITORY)).toBeNull();
  });

  test("the workspace question opens after an hour and closes when pushes work again", async () => {
    const { db, jobs } = lane();
    const hour = 100 + PUSH_OUTAGE_QUESTION_MS;
    await attempt(db, 100, () => "refused");
    await attempt(db, 101, () => "works");
    await attempt(db, 102, () => "works");
    expect(await askAboutPushOutage(db, REPOSITORY, hour - 1)).toBe("not_yet");
    expect(findOpenQuestion(db, "ses-a")).toBeNull();

    expect(await askAboutPushOutage(db, REPOSITORY, hour)).toBe("asked");
    const question = findOpenQuestion(db, "ses-a")!;
    expect(question).toMatchObject({ kind: "push-outage", itemId: "item-a" });
    expect(question.body).toContain("https://github.com/settings/installations/2");
    expect(question.body).toContain("denied to paws-helper[bot]");
    // One question for the workspace, not one per item, and the item keeps its state.
    expect(await askAboutPushOutage(db, REPOSITORY, hour + 10 * MINUTE)).toBe("already");
    for (const name of ["b", "c"]) expect(findOpenQuestion(db, `ses-${name}`)).toBeNull();
    expect(getWorkItem(db, "item-a")?.state).toBe("running");
    expect(
      listOutbox(db)
        .filter((row) => row.op === "elicitation")
        .map((row) => row.idempotencyKey),
    ).toEqual([`question:${question.id}`]);

    db.run("UPDATE job SET run_at = 0 WHERE id = ?", [jobs[0]]);
    await attempt(db, hour + 11 * MINUTE, () => "works");
    expect((await getQuestion(sqliteDb(db), question.id))?.cancelledAt).toBe(hour + 11 * MINUTE);
    expect(findOpenQuestion(db, "ses-a")).toBeNull();
  });
});
