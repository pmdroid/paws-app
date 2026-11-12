import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
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
  putWorkspaceUser,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { cloneRunnerPg, githubClient } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { runnerCheckout } from "./helpers";
import { seed as seedRows } from "./dialects";
import { tempStore } from "./pglite";

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
  const { db, close } = await tempStore();
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
  const runner = cloneRunnerPg(
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
    store: db,
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
    await seedRows(db, (q) => q.orm.update(q.t.workItem).set({ delegatedBy: "delegator-1" }));
    const turn = jobs.tick();
    await attachRunnerLease(db);
    await turn;
    await flush();

    const item = (await listWorkItems(db))[0]!;
    expect((await getWorkItem(db, item.id))?.state).toBe("awaiting_input");
    expect(checksRuns).toEqual([true]);
    expect(existsSync(checkMark)).toBe(false);
    const question = (await findOpenQuestion(db, "ses_1"))!;
    expect((await getLinkAsk(db, question.id))?.kind).toBe("rule");
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
    expect((await getWorkItem(db, item.id))?.state).toBe("merge_queue");
    // A runner-backed item reaches the merge queue with no worktree on the control plane.
    expect(existsSync(path.join(pawsRoot, "worktrees"))).toBe(false);
  } finally {
    await orchestrator.shutdown();
    await close();
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

async function attachRunnerLease(db: Db): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const item = (await listWorkItems(db))[0];
    const run = item?.currentRunId ? await getRun(db, item.currentRunId) : null;
    if (run?.status === "active") {
      const now = Date.now();
      const userId = await putWorkspaceUser(db, {
        id: "user-1",
        linearUserId: "user-linear",
        name: "Owner",
        email: "owner@example.invalid",
      });
      await seedRows(db, (q) =>
        q.orm
          .insert(q.t.workspace)
          .values({ id: "ws-1", linearOrganizationId: "org-1", name: "Workspace", createdAt: now }),
      );
      await syncWorkspaceMember(db, {
        workspaceId: "ws-1",
        userId,
        role: "admin",
        active: true,
        teamIds: [],
        now,
      });
      await seedRows(
        db,
        (q) =>
          q.orm.insert(q.t.runner).values({
            id: "runner-1",
            workspaceId: "ws-1",
            ownerUserId: userId,
            name: "Runner",
            status: "active",
            createdAt: now,
            lastSeenAt: now,
          }),
        (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "runner-1", capacity: 1 }),
        (q) =>
          q.orm.insert(q.t.runnerWork).values({
            runId: run.id,
            runnerId: "runner-1",
            workspaceId: "ws-1",
            generation: 1,
            runnerFence: 0,
            commandId: `cmd-${run.id}`,
            leaseUntil: now + 60_000,
          }),
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
