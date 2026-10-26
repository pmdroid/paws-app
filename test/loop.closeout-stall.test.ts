import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  enqueueJob,
  getRun,
  getWorkItem,
  listCloseoutRecoveries,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeCloseoutGate, type CloseoutVerdict } from "../src/closeout";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { githubClient } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const POLICY = `specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["true"]
    timeoutSeconds: 30
`;

/** PAS-629's verdict: the independent review failed and the fix did not land. */
function fixFailed(head: string): CloseoutVerdict {
  const summary = "Closeout: fix_failed\nindependent-review: failed";
  return {
    decision: "rejected",
    exhausted: false,
    summary,
    result: {
      outcome: "fix_failed",
      taskId: "ENG-7",
      base: "",
      head,
      fixAttempts: 1,
      evaluations: 1,
      exitCode: 1,
      summary,
      handoff: "Fix the P1 review finding.",
      decision: {
        specVersion: "0.1",
        decision: "rejected",
        gate: "beforePR",
        base: "",
        head,
        candidate: { session: "s", model: "m", provider: "p" },
        policy: { path: null, digest: null, absent: false },
        items: [
          { id: "test", kind: "command", state: "passed", message: "" },
          { id: "independent-review", kind: "review", state: "failed", message: "P1 finding" },
        ],
        warnings: [],
      },
    },
  };
}

test("a fix_failed verdict after the live operation was aborted restarts the item in the same job", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    expect(item.state).toBe("verifying");
    // As for PAS-629, an item.start job for the same item waits while this job verifies it.
    const second = enqueueJob(f.db, {
      queue: JOB_KIND.start,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    // Something aborts the live operation without moving the item out of verifying.
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    f.gate.next = fixFailed(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await interrupted;

    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    expect(restartReasons(f.db, item.id)).toEqual(["findings"]);
    const jobs = listJobs(f.db);
    // restart() fences the job that verified the item, and the pending item.start with it.
    expect(jobs.find((job) => job.id === f.jobId)?.status).toBe("cancelled");
    expect(jobs.find((job) => job.id === second)?.status).toBe("cancelled");
    expect(
      jobs.filter((job) => job.queue === JOB_KIND.resume && job.status === "pending"),
    ).toHaveLength(1);
    expect(f.stalls()).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("a job that ends with its item still in verifying journals why and asks for Closeout help", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    // The aborted Closeout run throws instead of returning a verdict.
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    f.release();
    await f.turn;
    await interrupted;
    await f.flush();

    expect(f.stalls()).toEqual([
      `job ${f.jobId} ${JOB_KIND.start} left item ${item.id} (ENG-7) in verifying: the job ended without a Closeout result`,
    ]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
    expect(listCloseoutRecoveries(f.db, item.id)).toHaveLength(1);
    expect(f.tracker.questions.at(-1)?.body).toContain(
      "Verification stopped without moving the task on: the job ended without a Closeout result.",
    );
  } finally {
    await f.close();
  }
}, 90_000);

test("a resume job claimed for an item in verifying journals and asks instead of ending silently", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    // The first job's result is lost with its lease; a later run.resume finds the item in verifying.
    f.db.run("UPDATE job SET locked_by = 'lost' WHERE id = ?", [f.jobId]);
    f.release();
    await f.turn;
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(f.stalls()).toEqual([]);

    f.db.run("UPDATE job SET status = 'done', locked_by = NULL WHERE id = ?", [f.jobId]);
    const resume = enqueueJob(f.db, {
      queue: JOB_KIND.resume,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    await f.tickAll();

    expect(f.stalls()).toEqual([
      `job ${resume} ${JOB_KIND.resume} left item ${item.id} (ENG-7) in verifying: the job ended without a Closeout result`,
    ]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
  } finally {
    await f.close();
  }
}, 90_000);

function restartReasons(db: Database, itemId: string): string[] {
  return db
    .query<{ reason: string }, [string]>(
      "SELECT reason FROM work_item_event WHERE item_id = ? AND kind = 'restart' ORDER BY id",
    )
    .all(itemId)
    .map((row) => row.reason);
}

/** One item whose turn ended and whose Closeout run is held open by the fake gate. */
async function verifyingWithHeldGate() {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-7",
      title: "Settings screen",
      description: null,
      subIssues: [],
    },
  ]);
  const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const gate = createFakeCloseoutGate();
  let release!: () => void;
  gate.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let thrown: Error | null = null;
  const run = gate.run;
  gate.run = async (input) => {
    const verdict = await run(input);
    if (thrown) throw thrown;
    return verdict;
  };
  const lines: string[] = [];
  let launches = 0;
  const launch: AgentLaunch = () => {
    launches += 1;
    const scriptPath = path.join(layout.root, `script-${launches}.json`);
    const resultPath = path.join(layout.root, `result-${launches}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        model: "test-claude-model",
        steps: [{ type: "end", stopReason: "end_turn" }],
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, resultPath, scriptPath],
      env: process.env,
    };
  };
  const github = createFakeGitHub();
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
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github),
    },
    launch,
    closeoutGate: () => gate,
    journal: (line) => lines.push(line),
  });
  await orchestrator.onLinearEvent(created());
  db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
  const turn = jobs.tick();
  await attachRunnerLease(db);
  const deadline = Date.now() + 30_000;
  while (gate.runs.length === 0) {
    if (Date.now() > deadline)
      throw new Error(
        JSON.stringify({ items: listWorkItems(db), lines, progress: tracker.progress }),
      );
    await Bun.sleep(20);
  }
  const jobId = listJobs(db).find((job) => job.status === "running")!.id;
  const flush = async () => {
    for (let round = 0; round < 20; round++) {
      const claimed = outbox.tick();
      await outbox.idle();
      if (claimed.length === 0) return;
    }
  };
  return {
    db,
    gate,
    jobId,
    release: () => release(),
    /** The held run throws this instead of returning its verdict. */
    throwFromRun(error: Error) {
      thrown = error;
    },
    turn,
    tracker,
    orchestrator,
    flush,
    stalls: () => lines.filter((line) => line.includes("in verifying:")),
    async tickAll() {
      while ((await jobs.tick()) !== null);
      await flush();
    },
    async close() {
      await orchestrator.shutdown();
      db.close();
      await layout.cleanup();
    },
  };
}

async function attachRunnerLease(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const item = listWorkItems(db)[0];
    const run = item?.currentRunId ? getRun(db, item.currentRunId) : null;
    if (run?.status === "active") {
      const now = Date.now();
      const userId = putWorkspaceUser(db, {
        id: "user-1",
        linearUserId: "user-linear",
        name: "Owner",
        email: "owner@example.invalid",
      });
      db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
      syncWorkspaceMember(db, {
        workspaceId: "ws-1",
        userId,
        role: "owner",
        active: true,
        teamIds: [],
        now,
      });
      db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
        ["runner-1", "ws-1", userId, "Runner", now, now],
      );
      db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", ["runner-1"]);
      db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
        [run.id, "runner-1", "ws-1", `cmd-${run.id}`, now + 60_000],
      );
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("implement run did not become active");
}

async function repoLayout() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-stall-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await mkdir(path.join(seed, ".agents"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), POLICY);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return { root, bare, pawsRoot, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function created(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
