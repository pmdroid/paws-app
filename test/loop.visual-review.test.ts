import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
  getRun,
  listEvidence,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  runnerHasCapacity,
  syncWorkspaceMember,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import {
  createFakeTracker,
  createLinearFileTransfer,
  type AcceptedLinearEvent,
} from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import {
  findOpenQuestion,
  getQuestion,
  VISUAL_REVIEW_ANSWERERS,
  VISUAL_REVIEW_QUESTION,
  VISUAL_REVIEW_REMINDER,
  VISUAL_REVIEW_REMINDER_MS,
  VISUAL_REVIEW_WAIT,
} from "../src/questions";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const ASSET = "https://uploads.linear.app/workspace/evidence";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const CLOSEOUT_POLICY = `specVersion: "0.1"
items:
  - id: visual-proof
    kind: evidence
    gate: beforePR
    media: [image]
    minimum: 2
    approval: human
`;

test("publishing the last required screenshot pauses the task and posts one question with the images", async () => {
  const f = await pausedForReview();
  try {
    const item = listWorkItems(f.db)[0]!;
    expect(item.state).toBe("awaiting_input");
    expect(item.checkpoint?.phase).toBe("awaiting_input");
    expect(getRun(f.db, item.currentRunId!)?.status).toBe("ended");
    expect(runnerHasCapacity(f.db, f.runnerId, Date.now())).toBe(true);
    // The fake agent keeps the reply to its last publish_artifact call: the second screenshot.
    expect(f.lastPublication()).toMatch(
      new RegExp(
        `^\\[shot-2\\.png\\]\\(<https://paws\\.example/evidence/[^>]+>\\)\\n\\n${VISUAL_REVIEW_WAIT}$`,
      ),
    );

    expect(f.tracker.questions).toHaveLength(1);
    const [question] = f.tracker.questions;
    expect(question!.options).toEqual(["Accept", "Request changes"]);
    expect(question!.body.startsWith(VISUAL_REVIEW_QUESTION)).toBe(true);
    expect(question!.body).toContain(`![shot-1.png](<${ASSET}>)`);
    expect(question!.body).toContain(`![shot-2.png](<${ASSET}>)`);
    expect(f.uploads.sort()).toEqual(["shot-1.png", "shot-2.png"]);
    expect(findOpenQuestion(f.db, "ses_1")?.body).toBe(VISUAL_REVIEW_QUESTION);
  } finally {
    await f.close();
  }
}, 90_000);

test("a reply from someone who can't approve gets a note and the task keeps waiting", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent(prompted("Accept", "someone-else"));
    expect(getQuestion(f.db, open.id)?.status).toBe("open");
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(0);
    expect(f.notes(VISUAL_REVIEW_ANSWERERS)).toBe(1);

    await f.orchestrator.onLinearEvent(prompted("Looks good", "delegator-1", "activity:ok"));
    expect(getQuestion(f.db, open.id)).toMatchObject({
      status: "answered",
      answeredBy: "delegator-1",
    });
    expect(f.notes(VISUAL_REVIEW_ANSWERERS)).toBe(1);
  } finally {
    await f.close();
  }
}, 90_000);

test("the project lead can answer the visual review", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent(prompted("Accept", "lead-1"));
    expect(getQuestion(f.db, open.id)).toMatchObject({ status: "answered", answeredBy: "lead-1" });
    expect(f.notes(VISUAL_REVIEW_ANSWERERS)).toBe(0);
  } finally {
    await f.close();
  }
}, 90_000);

test("the reminder is posted once after 24 hours", async () => {
  const f = await pausedForReview();
  try {
    await f.tickAll();
    expect(f.notes(VISUAL_REVIEW_REMINDER)).toBe(0);

    f.advance(VISUAL_REVIEW_REMINDER_MS - 60_000);
    await f.tickAll();
    expect(f.notes(VISUAL_REVIEW_REMINDER)).toBe(0);

    f.advance(60_000);
    await f.tickAll();
    expect(f.notes(VISUAL_REVIEW_REMINDER)).toBe(1);

    f.advance(VISUAL_REVIEW_REMINDER_MS * 3);
    await f.tickAll();
    expect(f.notes(VISUAL_REVIEW_REMINDER)).toBe(1);
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")).not.toBeNull();
  } finally {
    await f.close();
  }
}, 90_000);

test("stopping the task ends the wait", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent({
      ...prompted("", "delegator-1"),
      body: null,
      signal: "stop",
    });
    expect(listWorkItems(f.db)[0]!.state).toBe("cancelled");
    expect(getQuestion(f.db, open.id)?.status).toBe("cancelled");

    f.advance(VISUAL_REVIEW_REMINDER_MS);
    await f.tickAll();
    expect(f.notes(VISUAL_REVIEW_REMINDER)).toBe(0);
    await f.orchestrator.onLinearEvent(prompted("Accept", "delegator-1", "activity:late"));
    expect(getQuestion(f.db, open.id)?.answer).toBeNull();
  } finally {
    await f.close();
  }
}, 90_000);

async function pausedForReview() {
  const layout = await repoLayout();
  const tracker = Object.assign(
    createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-7",
        title: "Settings screen",
        description: null,
        subIssues: [],
      },
    ]),
    {
      async getIssueAttribution(issueId: string) {
        return {
          issueId,
          organizationId: "org-1",
          teamId: "team-1",
          projectId: "project-1",
          leadId: "lead-1",
        };
      },
    },
  );
  let offset = 0;
  const clock: Clock = { now: () => Date.now() + offset, mono: () => performance.now() + offset };
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const evidenceRoot = path.join(layout.pawsRoot, "evidence");
  const store = createEvidenceStore({ db, root: evidenceRoot });
  const uploads: string[] = [];
  const files = createLinearFileTransfer({
    client: {
      async query(_query, variables) {
        uploads.push(String((variables as { filename?: string }).filename));
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload",
              assetUrl: ASSET,
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "token";
      },
    },
    fetch: async () => new Response(null, { status: 200 }),
  });
  const results: string[] = [];
  let implementResult = "";
  const launch: AgentLaunch = (input) => {
    const n = results.length + 1;
    const scriptPath = path.join(layout.root, `script-${n}.json`);
    const resultPath = path.join(layout.root, `result-${n}.json`);
    results.push(resultPath);
    const steps =
      input.purpose === "implement"
        ? [
            { type: "publish_artifact", path: "shot-1.png", checkId: "visual-proof" },
            { type: "publish_artifact", path: "shot-2.png", checkId: "visual-proof" },
            { type: "end", stopReason: "end_turn" },
          ]
        : [{ type: "end", stopReason: "end_turn" }];
    if (input.purpose === "implement") implementResult = resultPath;
    if (input.purpose === "implement")
      for (const name of ["shot-1.png", "shot-2.png"])
        writeFileSync(path.join(input.worktree, name), Buffer.concat([PNG, Buffer.from(name)]));
    writeFileSync(scriptPath, JSON.stringify({ model: "test-claude-model", steps }));
    return {
      command: process.execPath,
      args: [fakeAgent, resultPath, scriptPath],
      env: process.env,
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    clock,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    files,
    evidence: {
      store: { save: (input) => store.save(input) },
      publicUrl: "https://paws.example",
      root: evidenceRoot,
    },
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    launch,
  });
  await orchestrator.onLinearEvent(created());
  db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
  const running = jobs.tick();
  const runnerId = leaseActiveRun(db);
  await running;
  await outboxIdle(outbox);
  expect(listEvidence(db, listWorkItems(db)[0]!.id)).toHaveLength(2);
  return {
    db,
    tracker,
    uploads,
    orchestrator,
    runnerId: await runnerId,
    advance(ms: number) {
      offset += ms;
    },
    async tickAll() {
      while ((await jobs.tick()) !== null);
      await outboxIdle(outbox);
    },
    notes(body: string) {
      return tracker.progress.filter((update) => update.body === body).length;
    },
    lastPublication() {
      const result = JSON.parse(readFileSync(implementResult, "utf8")) as {
        artifact?: { text?: string };
      };
      return result.artifact?.text;
    },
    async close() {
      await orchestrator.shutdown();
      db.close();
      await layout.cleanup();
    },
  };
}

async function outboxIdle(outbox: OutboxDispatcher): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const claimed = outbox.tick();
    await outbox.idle();
    if (claimed.length === 0) return;
  }
}

function leaseActiveRun(db: Database): Promise<string> {
  return (async () => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const item = listWorkItems(db)[0];
      const run = item?.currentRunId ? getRun(db, item.currentRunId) : null;
      if (run?.status === "active") return attachLease(db, run.id);
      await Bun.sleep(10);
    }
    throw new Error("implement run did not become active");
  })();
}

function attachLease(db: Database, runId: string): string {
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
    [runId, "runner-1", "ws-1", `cmd-${runId}`, now + 60_000],
  );
  return "runner-1";
}

async function repoLayout() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-visual-review-"));
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
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), CLOSEOUT_POLICY);
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

function prompted(body: string, actorId: string, key = "activity:ans"): AcceptedLinearEvent {
  return {
    dedupeKey: key,
    deliveryId: `del-${key}`,
    source: "webhook",
    action: "prompted",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: key.replace("activity:", ""),
    actorId,
    body,
    signal: null,
    updatedAtMs: Date.now() + 1_000,
    payload: "{}",
  };
}
