import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { JOB_KIND, type Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getLinkAsk,
  getRun,
  getWorkItem,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { githubClient } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { cloneRunner, runnerCheckout } from "./helpers";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("a checks run whose rule breaks asks the rule question before the checks, and they run after approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-rules-first-"));
  const checkMark = path.join(root, "check-ran");
  const bare = await originWithPolicy(root, checkMark);
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(pawsRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  const db = openDatabase(path.join(pawsRoot, "paws.db"));
  migrate(db);
  const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-7",
      title: "Settings screen",
      description: null,
      subIssues: [],
    },
  ]);
  const checksRuns: Array<boolean | undefined> = [];
  const repository = { owner: "pmdroid", repo: "paws-demo" };
  const runner = cloneRunner(
    repository,
    async (options: RunAgentOptions): Promise<RunAgentResult> => {
      if (options.checkpoint !== false) return runAgent(options);
      checksRuns.push(options.closeoutRulesFirst);
      const session = createCloseoutSession(options.worktreePath, {
        policy: async () => workspacePolicyFiles(options.worktreePath),
        ...(options.closeoutRulesFirst ? { rulesFirst: true } : {}),
      });
      const listed = JSON.parse(await session.report()) as { pending: string[] };
      for (const id of listed.pending) await session.run(id);
      return {
        role: "implementer",
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        closeoutReport: await session.report({ probes: true }),
      };
    },
    db,
  );
  const launch: AgentLaunch = (input) => {
    const scriptPath = path.join(root, `script-${crypto.randomUUID()}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        steps: [
          {
            type: "fs_write",
            path: path.join(runnerCheckout(pawsRoot, input.itemId), "feature.txt"),
            content: "new\n",
          },
          { type: "end", stopReason: "end_turn" },
        ],
      }),
    );
    return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
  };
  const github = createFakeGitHub();
  const orchestrator = attachOrchestrator({
    store: sqliteDb(db),
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    pawsRoot,
    home,
    tracker,
    publicUrl: "https://paws.example",
    repositories: [{ ...repository, remoteUrl: bare }],
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(bare, github),
    }),
    launch,
    remoteExecution: { agentForItem: () => runner, agentForSession: () => runAgent },
  });
  const flush = async () => {
    for (let round = 0; round < 20; round++) {
      const claimed = await outbox.tick();
      await outbox.idle();
      if (claimed.length === 0) return;
    }
  };
  try {
    await orchestrator.onLinearEvent(created());
    db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
    const turn = jobs.tick();
    await attachRunnerLease(db);
    await turn;
    await flush();

    const item = (await listWorkItems(sqliteDb(db)))[0]!;
    expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("awaiting_input");
    expect(checksRuns).toEqual([true]);
    expect(existsSync(checkMark)).toBe(false);
    const question = (await findOpenQuestion(sqliteDb(db), "ses_1"))!;
    expect((await getLinkAsk(sqliteDb(db), question.id))?.kind).toBe("rule");
    expect(tracker.questions.at(-1)?.body).toContain("Rule api-contract broke");

    expect(
      await orchestrator.decideLinkAsk({
        questionId: question.id,
        decision: "approve",
        note: "The field moved to a new route.",
        answeredBy: "delegator-1",
        actor: { workspaceId: "ws-1", userId: "user-1", name: "Owner" },
      }),
    ).toBe("answered");
    while ((await jobs.tick([JOB_KIND.reverify])) !== null);
    await flush();

    expect(checksRuns).toEqual([true, undefined]);
    expect(existsSync(checkMark)).toBe(true);
    expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("merge_queue");
    // A runner-backed item reaches the merge queue with no worktree on the control plane.
    expect(existsSync(path.join(pawsRoot, "worktrees"))).toBe(false);
  } finally {
    await orchestrator.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

async function originWithPolicy(root: string, checkMark: string): Promise<string> {
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await mkdir(path.join(seed, ".agents", "probes"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "probes", "contract.ts"), "process.exit(1);\n");
  const check = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(checkMark)}, "ran")`,
  ];
  await writeFile(
    path.join(seed, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ${JSON.stringify(check)}`,
      "    timeoutSeconds: 30",
      "rules:",
      "  - id: api-contract",
      "    summary: No removed field or route.",
      "    probe: .agents/probes/contract.ts",
      "    failOn: P1",
      "    onFail: approve",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return bare;
}

async function attachRunnerLease(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const item = (await listWorkItems(sqliteDb(db)))[0];
    const run = item?.currentRunId ? await getRun(sqliteDb(db), item.currentRunId) : null;
    if (run?.status === "active") {
      const now = Date.now();
      const userId = await putWorkspaceUser(sqliteDb(db), {
        id: "user-1",
        linearUserId: "user-linear",
        name: "Owner",
        email: "owner@example.invalid",
      });
      db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
      await syncWorkspaceMember(sqliteDb(db), {
        workspaceId: "ws-1",
        userId,
        role: "admin",
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
