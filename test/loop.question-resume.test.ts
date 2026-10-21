import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { systemClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getRun,
  getWorkItem,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recoverOnStartup,
  runnerHasCapacity,
  syncWorkspaceMember,
} from "../src/db";
import type { Database } from "bun:sqlite";
import { answerQuestion, findOpenQuestion, handoffNote } from "../src/questions";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { worktreePath } from "../src/acp";
import { attachOrchestrator, itemPathId, type AgentLaunch } from "../src/loop";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

const CLOSEOUT_POLICY = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "check.test.ts"]
    timeoutSeconds: 60
  - id: adversarial-review
    kind: review
    gate: beforePR
    skill: .agents/skills/adversarial-review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
`;

const REVIEW_SKILL = `---
name: adversarial-review
description: Review the candidate. Report findings. Do not decide acceptance.
---

# Review

Report findings. An empty list means the change is fine.
`;

const SEEDED_TEST = `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("seeded check", () => {
  expect(existsSync("ok.txt")).toBe(true);
});
`;

const ASK_TURN_REPLY =
  "Question posted to the team. End your turn now without further changes; you will be resumed with the answer as your next message.";

test("asking ends the run and an answer resumes through verification", async () => {
  const fixture = await askOnce();
  try {
    const item = listWorkItems(fixture.db)[0]!;
    const tree = worktreePath(fixture.layout.pawsRoot, itemPathId(item));
    const head = (await exec("git", ["-C", tree, "rev-parse", "HEAD"])).stdout.trim();
    expect(await exec("git", ["-C", tree, "show", `HEAD:during-question.txt`])).toMatchObject({
      stdout: "kept\n",
    });
    expect(await exec("git", ["-C", tree, "show", "HEAD:after-question.txt"])).toMatchObject({
      stdout: "also-kept\n",
    });
    expect(await exec("git", ["-C", tree, "status", "--porcelain"])).toMatchObject({
      stdout: "",
    });
    expect(item.checkpoint).toMatchObject({ phase: "awaiting_input", wipCommit: head });
    expect(item.state).toBe("awaiting_input");
    expect(getRun(fixture.db, item.currentRunId!)?.status).toBe("ended");
    expect(
      fixture.results
        .map(
          (result) => JSON.parse(readFileSync(result, "utf8")) as { askTeam?: { text?: string } },
        )
        .find((result) => result.askTeam)?.askTeam?.text,
    ).toBe(ASK_TURN_REPLY);
    expect(runnerHasCapacity(fixture.db, fixture.runnerId, Date.now())).toBe(true);
    expect(
      fixture.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM runner_work WHERE runner_id = ? AND ended_at IS NULL",
        )
        .get(fixture.runnerId)?.n,
    ).toBe(0);
    expect(
      fixture.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM runner_work_grant WHERE run_id = ?",
        )
        .get(item.currentRunId!)?.n,
    ).toBe(0);
    expect(fixture.tracker.questions[0]?.body).toContain("Include archived rows?");
    expect(fixture.tracker.questions[0]?.options).toEqual(["yes", "no"]);

    await fixture.orchestrator.onLinearEvent(prompted("parquet"));
    const resume = listJobs(fixture.db).find((job) => job.queue === JOB_KIND.resume);
    expect(resume?.status).toBe("pending");
    expect(resume?.payload).toMatchObject({
      itemId: item.id,
      freshSession: true,
      reason: "answer",
      handoff: handoffNote({
        question: "Include archived rows?",
        options: ["yes", "no"],
        answer: "parquet",
      }),
    });

    await drive(fixture, ["verifying", "merge_queue", "merged"]);
    const state = getWorkItem(fixture.db, item.id)?.state ?? "";
    expect(["verifying", "merge_queue", "merged"]).toContain(state);
    expect(fixture.prompts.some((prompt) => prompt.includes("Answer: parquet"))).toBe(true);
    const received = fixture.results
      .map((result) => JSON.parse(readFileSync(result, "utf8")) as { prompts?: unknown[] })
      .flatMap((result) => result.prompts ?? [])
      .map((prompt) =>
        (prompt as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n"),
      );
    const firstRequest = received[0]!.trim().split("\n")[0]!;
    expect(firstRequest.length).toBeGreaterThan(10);
    expect(received.find((prompt) => prompt.includes("Answer: parquet"))).toContain(firstRequest);
    expect(fixture.resumeHeads).toEqual([head]);
    const resumed = getWorkItem(fixture.db, item.id)!;
    expect(resumed.currentRunId).not.toBe(item.currentRunId);
    const status = getRun(fixture.db, resumed.currentRunId!)?.status ?? "";
    expect(["active", "ended"]).toContain(status);
  } finally {
    await fixture.orchestrator.shutdown();
    fixture.db.close();
    await fixture.layout.cleanup();
  }
}, 90_000);

test("startup resumes an answered question and leaves an open one parked", async () => {
  const fixture = await askOnce();
  try {
    const item = listWorkItems(fixture.db)[0]!;
    const open = findOpenQuestion(fixture.db, "ses_1");
    expect(open?.status).toBe("open");
    const jobsBefore = listJobs(fixture.db).filter((job) => job.queue === JOB_KIND.resume);
    expect(recoverOnStartup(fixture.db)).toEqual([]);
    expect(getWorkItem(fixture.db, item.id)?.state).toBe("awaiting_input");
    expect(listJobs(fixture.db).filter((job) => job.queue === JOB_KIND.resume)).toEqual(jobsBefore);
    expect(getRun(fixture.db, item.currentRunId!)?.status).toBe("ended");

    answerQuestion(fixture.db, open!.id, {
      answer: "parquet",
      answeredBy: "human-1",
      now: Date.now(),
    });
    expect(getWorkItem(fixture.db, item.id)?.state).toBe("awaiting_input");
    recoverOnStartup(fixture.db);
    expect(getWorkItem(fixture.db, item.id)).toMatchObject({
      state: "running",
      recoveryAttempts: 0,
    });
    const resume = listJobs(fixture.db).find(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    );
    expect(resume?.jobKey).toBe(`resume:answer:${open!.id}`);
    expect(resume?.payload).toMatchObject({
      freshSession: true,
      reason: "answer",
      handoff: handoffNote({
        question: open!.body,
        options: open!.options,
        answer: "parquet",
      }),
    });

    await drive(fixture, ["verifying", "merge_queue", "merged"]);
    expect(fixture.prompts.some((prompt) => prompt.includes("Answer: parquet"))).toBe(true);
  } finally {
    await fixture.orchestrator.shutdown();
    fixture.db.close();
    await fixture.layout.cleanup();
  }
}, 90_000);

test("an answer that arrives before the asking turn ends resumes once after the run ends", async () => {
  const fixture = await askOnce("parquet");
  try {
    const item = listWorkItems(fixture.db)[0]!;
    expect(fixture.resumeJobsDuringTurn).toEqual([0]);
    expect(getRun(fixture.db, item.currentRunId!)?.status).toBe("ended");
    const resumes = listJobs(fixture.db).filter((job) => job.queue === JOB_KIND.resume);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.payload).toMatchObject({
      itemId: item.id,
      reason: "answer",
      handoff: handoffNote({
        question: "Include archived rows?",
        options: ["yes", "no"],
        answer: "parquet",
      }),
    });
    await drive(fixture, ["verifying", "merge_queue", "merged"]);
    expect(fixture.prompts.some((prompt) => prompt.includes("Answer: parquet"))).toBe(true);
  } finally {
    await fixture.orchestrator.shutdown();
    fixture.db.close();
    await fixture.layout.cleanup();
  }
}, 90_000);

async function askOnce(answerDuringTurn?: string): Promise<{
  layout: { pawsRoot: string; cleanup: () => Promise<void> };
  db: Database;
  jobs: JobLoop;
  orchestrator: ReturnType<typeof attachOrchestrator>;
  tracker: ReturnType<typeof createFakeTracker>;
  prompts: string[];
  results: string[];
  resumeHeads: string[];
  runnerId: string;
  resumeJobsDuringTurn: number[];
}> {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-9",
      title: "Export rows",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const prompts: string[] = [];
  const results: string[] = [];
  const resumeHeads: string[] = [];
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    prompts.push(input.prompt);
    scripts += 1;
    const scriptPath = path.join(layout.root, `script-${scripts}.json`);
    const resultPath = path.join(layout.root, `result-${scripts}.json`);
    results.push(resultPath);
    const handed = input.prompt.includes("Handoff from the previous session.");
    if (handed) {
      resumeHeads.push(
        execFileSync("git", ["-C", input.worktree, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      );
      expect(readFileSync(path.join(input.worktree, "during-question.txt"), "utf8")).toBe("kept\n");
      expect(readFileSync(path.join(input.worktree, "after-question.txt"), "utf8")).toBe(
        "also-kept\n",
      );
      expect(
        execFileSync("git", ["-C", input.worktree, "status", "--porcelain"], {
          encoding: "utf8",
        }),
      ).toBe("");
    }
    const steps =
      input.purpose === "review"
        ? [
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "[]" },
              },
            },
            { type: "end", stopReason: "end_turn" },
          ]
        : input.purpose === "implement" && !handed
          ? [
              {
                type: "fs_write",
                path: path.join(input.worktree, "during-question.txt"),
                content: "kept\n",
              },
              {
                type: "ask_team",
                question: "Include archived rows?",
                options: ["yes", "no"],
              },
              {
                type: "fs_write",
                path: path.join(input.worktree, "after-question.txt"),
                content: "also-kept\n",
              },
              { type: "end", stopReason: "end_turn" },
            ]
          : input.purpose === "implement"
            ? [
                {
                  type: "fs_write",
                  path: path.join(input.worktree, "ok.txt"),
                  content: "ok\n",
                },
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Exported the rows." },
                  },
                },
                { type: "end", stopReason: "end_turn" },
              ]
            : [{ type: "end", stopReason: "end_turn" }];
    writeFileSync(
      scriptPath,
      JSON.stringify({
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
        steps,
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, resultPath, scriptPath],
      env: process.env,
    };
  };
  const resumeJobsDuringTurn: number[] = [];
  let answered: Promise<void> = Promise.resolve();
  if (answerDuringTurn) {
    const ask = tracker.askQuestion.bind(tracker);
    tracker.askQuestion = async (question, options) => {
      await ask(question, options);
      setImmediate(() => {
        answered = orchestrator.onLinearEvent(prompted(answerDuringTurn)).then(() => {
          const run = db
            .query<{ status: string }, []>(
              "SELECT status FROM run ORDER BY created_at DESC, id DESC LIMIT 1",
            )
            .get();
          resumeJobsDuringTurn.push(
            run?.status === "ended"
              ? -1
              : listJobs(db).filter((job) => job.queue === JOB_KIND.resume).length,
          );
        });
      });
    };
  }
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      client: {
        async request() {
          return { status: 404, body: {} };
        },
      },
    },
    launch,
  });
  await orchestrator.onLinearEvent(created());
  const running = jobs.tick();
  const runnerId = leaseActiveRun(db);
  await running;
  await answered;
  return {
    layout,
    db,
    jobs,
    orchestrator,
    tracker,
    prompts,
    results,
    resumeHeads,
    runnerId: await runnerId,
    resumeJobsDuringTurn,
  };
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
  db.run("INSERT INTO runner_work_grant(token_hash,run_id,generation,expires_at) VALUES(?,?,1,?)", [
    `grant-${runId}`,
    runId,
    now + 60_000,
  ]);
  return "runner-1";
}

async function drive(
  fixture: { db: Database; jobs: JobLoop },
  states: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let idle = 0;
  while (Date.now() < deadline) {
    const state = getWorkItem(fixture.db, listWorkItems(fixture.db)[0]!.id)?.state;
    if (state && states.includes(state)) return;
    if (state === "failed" || state === "exhausted") {
      throw new Error(JSON.stringify(listJobs(fixture.db)));
    }
    const job = await fixture.jobs.tick();
    if (job === null) {
      idle += 1;
      if (idle > 3) break;
      await Bun.sleep(20);
    } else {
      idle = 0;
    }
  }
}

async function repoLayout(): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-question-"));
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
  await mkdir(path.join(seed, ".agents", "skills", "adversarial-review"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), CLOSEOUT_POLICY);
  await writeFile(
    path.join(seed, ".agents", "skills", "adversarial-review", "SKILL.md"),
    REVIEW_SKILL,
  );
  await writeFile(path.join(seed, "check.test.ts"), SEEDED_TEST);
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

function prompted(body: string): AcceptedLinearEvent {
  return {
    dedupeKey: "activity:ans",
    deliveryId: "del",
    source: "webhook",
    action: "prompted",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: "ans",
    actorId: "human-1",
    body,
    signal: null,
    updatedAtMs: Date.now() + 1_000,
    payload: "{}",
  };
}

test("the implementer's prompt includes the project overview with its mock links", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-9",
      title: "Export rows",
      description: null,
      subIssues: [],
    },
  ]);
  tracker.projectOverviews.set("issue", {
    name: "Exports",
    content: "## Mocks\n\n![Export page](https://uploads.linear.app/workspace/export-mock.png)",
  });
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const prompts: { purpose: string; prompt: string }[] = [];
  const launch: AgentLaunch = (input) => {
    prompts.push({ purpose: input.purpose, prompt: input.prompt });
    const scriptPath = path.join(layout.root, `overview-${prompts.length}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
        steps: [{ type: "end", stopReason: "end_turn" }],
      }),
    );
    return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      client: {
        async request() {
          return { status: 404, body: {} };
        },
      },
    },
    launch,
  });
  try {
    await orchestrator.onLinearEvent(created());
    for (let tick = 0; tick < 20 && !prompts.some((entry) => entry.purpose === "implement"); tick++)
      await jobs.tick();
    const implement = prompts.find((entry) => entry.purpose === "implement");
    expect(implement?.prompt).toContain("Project overview: Exports");
    expect(implement?.prompt).toContain("https://uploads.linear.app/workspace/export-mock.png");
  } finally {
    db.close();
    await layout.cleanup();
  }
});
