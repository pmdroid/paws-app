import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  getWorkItem,
  listEvidence,
  listJobs,
  listVisualReviewMarks,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  runnerHasCapacity,
  syncWorkspaceMember,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeGitHub } from "../src/github";
import {
  createFakeTracker,
  createLinearFileTransfer,
  type AcceptedLinearEvent,
} from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import {
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  rejectedEvidenceIds,
  visualReviewContinueQuestion,
  VISUAL_REVIEW_ANSWERERS,
  VISUAL_REVIEW_DESCRIBE,
  VISUAL_REVIEW_ROUNDS,
  VISUAL_REVIEW_QUESTION,
  VISUAL_REVIEW_REMINDER,
  VISUAL_REVIEW_REMINDER_MS,
  VISUAL_REVIEW_WAIT,
} from "../src/questions";
import { githubClient } from "./e2e-harness";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const ASSET = "https://uploads.linear.app/workspace/evidence";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function closeoutPolicy(paths?: string[]): string {
  return `specVersion: "0.1"
items:
  - id: visual-proof
    kind: evidence
    gate: beforePR
    media: [image]
    minimum: 2
    approval: human
${paths ? `    paths: ${JSON.stringify(paths)}\n` : ""}`;
}

type Step = Record<string, unknown>;

function publishTwo(worktree: string, n: number): Step[] {
  const names = [`shot-${2 * n - 1}.png`, `shot-${2 * n}.png`];
  for (const name of names)
    writeFileSync(path.join(worktree, name), Buffer.concat([PNG, Buffer.from(name)]));
  return names.map((name) => ({ type: "publish_artifact", path: name, checkId: "visual-proof" }));
}

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

test("Accept records the approval, passes the check and opens the pull request", async () => {
  const f = await pausedForReview();
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    const wip = item.checkpoint?.wipCommit;
    expect(wip).toMatch(/^[0-9a-f]{40}$/);
    putWorkspaceUser(f.db, {
      id: "user-ada",
      linearUserId: "delegator-1",
      name: "Ada Reviewer",
      email: "ada@example.invalid",
    });

    await f.orchestrator.onLinearEvent(prompted("Accept", "delegator-1"));
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "accepted",
      answeredBy: "delegator-1",
      headCommit: wip,
      evidenceIds: listEvidence(f.db, item.id).map((row) => row.id),
    });
    expect(getVisualReview(f.db, open.id)?.answeredAt).toBeNumber();

    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.github.opened).toHaveLength(1);
    const body = f.github.opened[0]!.body;
    expect(body).toContain(
      "Visual review accepted by Ada Reviewer in [Linear](<https://linear.app/issue/ENG-7>).",
    );
    expect(body).toContain(`![shot-1.png](<${ASSET}>)`);
    expect(body).toContain(`![shot-2.png](<${ASSET}>)`);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("The visual review of check visual-proof was accepted");
    expect(f.tracker.questions).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)?.state).not.toBe("awaiting_input");
  } finally {
    await f.close();
  }
}, 120_000);

test("Request changes resumes the agent with the feedback, and new screenshots ask again", async () => {
  const f = await pausedForReview();
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;

    await f.orchestrator.onLinearEvent(prompted("Request changes", "delegator-1"));
    expect(getQuestion(f.db, first.id)?.status).toBe("open");
    expect(f.notes(VISUAL_REVIEW_DESCRIBE)).toBe(1);

    await f.orchestrator.onLinearEvent(
      prompted("Make the hint under Model shorter", "delegator-1", "activity:changes"),
    );
    expect(getVisualReview(f.db, first.id)).toMatchObject({
      outcome: "changes_requested",
      feedback: "Make the hint under Model shorter",
    });
    const before = listEvidence(f.db, item.id).map((row) => row.id);
    expect([...rejectedEvidenceIds(f.db, item.id)].sort()).toEqual(before.sort());

    await f.driveUntil(() => f.tracker.questions.length === 2);
    expect(f.prompts[1]).toContain("Make the hint under Model shorter");
    expect(f.prompts[1]).toContain('checkId "visual-proof"');
    const second = f.tracker.questions[1]!;
    expect(second.body).toContain("shot-3.png");
    expect(second.body).toContain("shot-4.png");
    expect(second.body).not.toContain("shot-1.png");
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    const rejected = rejectedEvidenceIds(f.db, item.id);
    expect(
      listEvidence(f.db, item.id)
        .filter((row) => !rejected.has(row.id))
        .map((row) => row.displayName),
    ).toEqual(["shot-3.png", "shot-4.png"]);
  } finally {
    await f.close();
  }
}, 120_000);

test("Request changes from the run page hands the marked screenshot and note to the agent", async () => {
  let worktree = "";
  const f = await pausedForReview({
    implement(dir, n, prompt) {
      worktree = dir;
      return n === 1 || prompt.includes('publish_artifact and checkId "visual-proof"')
        ? publishTwo(dir, n)
        : [];
    },
  });
  try {
    const open = findOpenQuestion(f.db, "ses_1")!;
    const item = listWorkItems(f.db)[0]!;
    const shot = listEvidence(f.db, item.id)[1]!;
    const marked = Buffer.concat([PNG, Buffer.from("red circle")]);
    const mark = {
      id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      questionId: open.id,
      evidenceId: shot.id,
      sizeBytes: marked.byteLength,
      sha256: createHash("sha256").update(marked).digest("hex"),
      createdAt: Date.now(),
    };
    writeFileSync(path.join(f.evidenceRoot, mark.id), marked);
    const request = { questionId: open.id, note: "Move the save button left", marks: [mark] };

    expect(
      await f.orchestrator.requestVisualReviewChanges({ ...request, answeredBy: "someone-else" }),
    ).toBe("forbidden");
    expect(getQuestion(f.db, open.id)?.status).toBe("open");
    expect(listVisualReviewMarks(f.db, open.id)).toEqual([]);

    expect(
      await f.orchestrator.requestVisualReviewChanges({ ...request, answeredBy: "delegator-1" }),
    ).toBe("answered");
    expect(getVisualReview(f.db, open.id)).toMatchObject({
      outcome: "changes_requested",
      answeredBy: "delegator-1",
      feedback: "Move the save button left",
    });
    expect(listVisualReviewMarks(f.db, open.id)).toEqual([mark]);
    expect(
      await f.orchestrator.requestVisualReviewChanges({ ...request, answeredBy: "delegator-1" }),
    ).toBe("rejected");

    await f.driveUntil(() => f.tracker.questions.length === 2);
    expect(f.prompts[1]).toContain("Move the save button left");
    expect(f.prompts[1]).toContain(
      `- ./.paws-visual-review/${mark.id}.png: shot-2.png (evidence ${shot.id}, published at commit ${shot.headCommit.slice(0, 7)})`,
    );
    const text = f
      .received(1)
      .map((block) => block.text ?? "")
      .join("\n");
    const local = new RegExp(`\\./\\.paws-visual-review/[0-9a-f]{64}/${mark.id}\\.png`).exec(
      text,
    )?.[0];
    expect(local).toBeString();
    expect(text).toContain(`Input file: ${local} (image/png)`);
    expect(readFileSync(path.join(worktree, local!))).toEqual(marked);
    const ignored = await exec("git", ["-C", worktree, "check-ignore", local!]);
    expect(ignored.stdout.trim()).toBe(local!);
    expect(readFileSync(path.join(f.evidenceRoot, shot.id))).toEqual(
      Buffer.concat([PNG, Buffer.from("shot-2.png")]),
    );
  } finally {
    await f.close();
  }
}, 120_000);

test("after three rounds of changes Paws asks whether to keep going instead of resuming", async () => {
  const f = await pausedForReview();
  try {
    for (let round = 1; round <= VISUAL_REVIEW_ROUNDS; round++) {
      await f.orchestrator.onLinearEvent(
        prompted(`Change ${round}`, "delegator-1", `activity:change-${round}`),
      );
      if (round < VISUAL_REVIEW_ROUNDS)
        await f.driveUntil(() => f.tracker.questions.length === round + 1);
    }
    await f.tickAll();
    expect(f.prompts).toHaveLength(VISUAL_REVIEW_ROUNDS);
    expect(f.tracker.questions).toHaveLength(VISUAL_REVIEW_ROUNDS + 1);
    const asked = f.tracker.questions.at(-1)!;
    expect(asked.body).toContain(visualReviewContinueQuestion(VISUAL_REVIEW_ROUNDS));
    expect(asked.options).toEqual(["Keep going"]);
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");
    expect(
      listJobs(f.db).filter((job) => job.queue === JOB_KIND.resume && job.finishedAt === null),
    ).toEqual([]);

    await f.orchestrator.onLinearEvent(
      prompted("Keep going", "delegator-1", "activity:keep-going"),
    );
    await f.driveUntil(() => f.tracker.questions.length === VISUAL_REVIEW_ROUNDS + 2);
    expect(f.prompts).toHaveLength(VISUAL_REVIEW_ROUNDS + 1);
    expect(f.prompts.at(-1)).toContain(`Change ${VISUAL_REVIEW_ROUNDS}`);
    expect(f.tracker.questions.at(-1)!.options).toEqual(["Accept", "Request changes"]);
  } finally {
    await f.close();
  }
}, 180_000);

test("a change under the check's paths after acceptance asks again", async () => {
  const f = await pausedForReview({
    paths: ["web/**"],
    implement(worktree, n) {
      if (n <= 2) {
        mkdirSync(path.join(worktree, "web"), { recursive: true });
        writeFileSync(path.join(worktree, "web", "settings.html"), `<p>version ${n}</p>\n`);
      }
      if (n === 1) return publishTwo(worktree, 1);
      return n === 3 ? publishTwo(worktree, 2) : [];
    },
  });
  try {
    const first = findOpenQuestion(f.db, "ses_1")!;
    await f.orchestrator.onLinearEvent(prompted("Accept", "delegator-1"));
    await f.driveUntil(() => f.tracker.questions.length === 2);

    expect(getVisualReview(f.db, first.id)?.outcome).toBe("stale");
    expect(f.github.opened).toHaveLength(0);
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[2]).toContain("changed after its visual review was accepted");
    expect(f.tracker.questions[1]!.body).toContain("shot-3.png");
    expect(listWorkItems(f.db)[0]!.state).toBe("awaiting_input");

    await f.orchestrator.onLinearEvent(prompted("Accept", "delegator-1", "activity:accept-2"));
    await f.driveUntil(() => f.github.opened.length > 0);
    expect(f.github.opened).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 180_000);

async function pausedForReview(
  options: {
    paths?: string[];
    implement?: (worktree: string, n: number, prompt: string) => Step[];
  } = {},
) {
  const layout = await repoLayout(closeoutPolicy(options.paths));
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
  const github = createFakeGitHub();
  const results: string[] = [];
  const prompts: string[] = [];
  const implementResults: string[] = [];
  let implementResult = "";
  const implement =
    options.implement ??
    ((worktree: string, n: number, prompt: string) =>
      n === 1 || prompt.includes('publish_artifact and checkId "visual-proof"')
        ? publishTwo(worktree, n)
        : []);
  const launch: AgentLaunch = (input) => {
    const n = results.length + 1;
    const scriptPath = path.join(layout.root, `script-${n}.json`);
    const resultPath = path.join(layout.root, `result-${n}.json`);
    results.push(resultPath);
    let steps: Step[] = [];
    if (input.purpose === "implement") {
      prompts.push(input.prompt);
      implementResults.push(resultPath);
      if (prompts.length === 1) implementResult = resultPath;
      steps = implement(input.worktree, prompts.length, input.prompt);
    }
    steps.push({ type: "end", stopReason: "end_turn" });
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
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github),
    },
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
    github,
    prompts,
    uploads,
    orchestrator,
    evidenceRoot,
    received(n: number) {
      const result = JSON.parse(readFileSync(implementResults[n]!, "utf8")) as {
        prompts?: { type: string; text?: string }[][];
      };
      return (result.prompts ?? []).flat();
    },
    runnerId: await runnerId,
    advance(ms: number) {
      offset += ms;
    },
    async tickAll() {
      while ((await jobs.tick()) !== null);
      await outboxIdle(outbox);
    },
    async driveUntil(done: () => boolean) {
      const deadline = Date.now() + 90_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(JSON.stringify(listJobs(db)));
        const state = listWorkItems(db)[0]!.state;
        if (state === "failed" || state === "exhausted")
          throw new Error(`task ${state}: ${JSON.stringify(listWorkItems(db)[0])}`);
        const job = await jobs.tick();
        await outboxIdle(outbox);
        if (job === null) await Bun.sleep(20);
      }
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

async function repoLayout(policy: string) {
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
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), policy);
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
