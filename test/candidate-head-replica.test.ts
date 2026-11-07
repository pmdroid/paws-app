import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  candidateRef,
  ensureBareMirror,
  ensureCandidateRef,
  mirrorPath,
  restoreCandidateRef,
  runAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../src/acp";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { JOB_KIND, type Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getItemCandidate,
  getRun,
  getWorkItem,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordItemCandidate,
  syncWorkspaceMember,
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

const repository = { owner: "acme", repo: "app" };

async function git(...args: string[]): Promise<string> {
  return (await exec("git", args)).stdout.trim();
}

function instance(input: {
  root: string;
  name: string;
  bare: string;
  dbPath: string;
  checksRuns: string[];
}) {
  const pawsRoot = path.join(input.root, input.name);
  const home = path.join(input.root, `${input.name}-home`);
  const db = openDatabase(input.dbPath);
  migrate(db);
  const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ACME-7",
      title: "Settings screen",
      description: null,
      subIssues: [],
    },
  ]);
  const clone = cloneRunner(repository, async (options): Promise<RunAgentResult> => {
    if (options.checkpoint !== false) return runAgent(options);
    input.checksRuns.push(
      `${input.name}:${await git("-C", options.worktreePath, "rev-parse", "HEAD")}`,
    );
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
  });
  // Stands in for the runner backend's import: the runner pushed its branch to GitHub, and the
  // control plane moved the candidate ref and recorded it.
  const runner = async (options: RunAgentOptions): Promise<RunAgentResult> => {
    const result = await clone(options);
    if (options.role !== "implementer" || options.checkpoint === false) return result;
    const item = listWorkItems(db)[0]!;
    const mirror = mirrorPath(options.pawsRoot, repository.owner, repository.repo);
    const sha = await git("--git-dir", mirror, "rev-parse", candidateRef(options.itemId));
    await git(
      "--git-dir",
      mirror,
      "push",
      "-q",
      input.bare,
      `${sha}:refs/heads/${item.branchName}`,
    );
    recordItemCandidate(db, {
      itemId: item.id,
      sha,
      branch: item.branchName,
      recordedAt: Date.now(),
    });
    return result;
  };
  const launch: AgentLaunch = (launched) => {
    const scriptPath = path.join(input.root, `script-${crypto.randomUUID()}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        steps: [
          {
            type: "fs_write",
            path: path.join(runnerCheckout(pawsRoot, launched.itemId), "feature.txt"),
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
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    pawsRoot,
    home,
    tracker,
    publicUrl: "https://paws.example",
    repositories: [{ ...repository, remoteUrl: input.bare }],
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(input.bare, github, [], repository),
    }),
    launch,
    remoteExecution: { agentForItem: () => runner, agentForSession: () => runAgent },
  });
  const flush = async () => {
    for (let round = 0; round < 20; round++) {
      const claimed = outbox.tick();
      await outbox.idle();
      if (claimed.length === 0) return;
    }
  };
  return { pawsRoot, db, jobs, tracker, github, orchestrator, flush };
}

test("instance B verifies and merges the candidate instance A imported, from the recorded SHA", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-candidate-replica-"));
  const checkMark = path.join(root, "check-ran");
  const bare = await originWithPolicy(root, checkMark);
  await mkdir(path.join(root, "shared"), { recursive: true });
  const dbPath = path.join(root, "shared", "paws.db");
  const checksRuns: string[] = [];
  const a = instance({ root, name: "a", bare, dbPath, checksRuns });
  const b = instance({ root, name: "b", bare, dbPath, checksRuns });
  try {
    await a.orchestrator.onLinearEvent(created());
    a.db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
    const turn = a.jobs.tick();
    await attachRunnerLease(a.db);
    await turn;
    await a.flush();

    const item = listWorkItems(b.db)[0]!;
    expect(getWorkItem(b.db, item.id)?.state).toBe("awaiting_input");
    const recorded = getItemCandidate(b.db, item.id)!;
    expect(recorded.branch).toBe(item.branchName);
    expect(checksRuns).toEqual([`a:${recorded.sha}`]);

    // Run files stay on local disk for now; only the mirror differs between the instances.
    await cp(path.join(a.pawsRoot, "runs"), path.join(b.pawsRoot, "runs"), { recursive: true });
    const question = findOpenQuestion(b.db, "ses_1")!;
    expect(
      await b.orchestrator.decideLinkAsk({
        questionId: question.id,
        decision: "approve",
        note: "The field moved to a new route.",
        answeredBy: "delegator-1",
        actor: { workspaceId: "ws-1", userId: "user-1", name: "Owner" },
      }),
    ).toBe("answered");
    while ((await b.jobs.tick([JOB_KIND.reverify])) !== null);
    await b.flush();

    expect(checksRuns).toEqual([`a:${recorded.sha}`, `b:${recorded.sha}`]);
    const mirrorB = mirrorPath(b.pawsRoot, repository.owner, repository.repo);
    expect(
      await git(
        "--git-dir",
        mirrorB,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/paws/candidates",
      ),
    ).toBe(recorded.sha);
    expect(getWorkItem(b.db, item.id)?.state).toBe("merge_queue");

    for (let tick = 0; tick < 20 && getWorkItem(b.db, item.id)?.state !== "merged"; tick++) {
      await b.jobs.tick();
      await b.flush();
    }
    expect(getWorkItem(b.db, item.id)?.state).toBe("merged");
    expect(b.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([recorded.sha]);
    expect(a.github.merged).toEqual([]);
  } finally {
    await a.orchestrator.shutdown();
    await b.orchestrator.shutdown();
    a.db.close();
    b.db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("a recorded candidate SHA that GitHub lacks is an error that names it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-candidate-missing-"));
  try {
    const bare = await originWithPolicy(root, path.join(root, "check-ran"));
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const restore = restoreCandidateRef({
      ...repository,
      remoteUrl: bare,
      itemId: "01ACME",
      pawsRoot: path.join(root, "b"),
      sha: missing,
      signal: AbortSignal.timeout(30_000),
    });
    await expect(restore).rejects.toThrow(
      `Candidate head ${missing} of 01ACME is missing on GitHub`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a GitHub remote is never fetched without the repository's authenticated git", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-candidate-access-"));
  try {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const restore = restoreCandidateRef({
      ...repository,
      remoteUrl: "https://github.com/acme/app.git",
      itemId: "01ACME",
      pawsRoot: path.join(root, "b"),
      sha,
      signal: AbortSignal.timeout(30_000),
    });
    await expect(restore).rejects.toThrow(`Candidate head ${sha} of 01ACME needs GitHub access`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rolled-back candidate restores the recorded SHA over the cached descendant, and an unrelated one is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-candidate-cache-"));
  try {
    const bare = await originWithPolicy(root, path.join(root, "check-ran"));
    const pawsRoot = path.join(root, "a");
    const place = { ...repository, remoteUrl: bare, itemId: "01ACME", pawsRoot };
    const signal = AbortSignal.timeout(30_000);
    const {
      mirrorPath: mirror,
      ref,
      head: main,
    } = await ensureBareMirror(place).then(() => ensureCandidateRef(place));
    const tree = await git("--git-dir", mirror, "rev-parse", `${main}^{tree}`);
    const ahead = await git(
      "--git-dir",
      mirror,
      "-c",
      "user.name=acme",
      "-c",
      "user.email=acme@example.com",
      "commit-tree",
      tree,
      "-p",
      main,
      "-m",
      "ahead",
    );
    await git("--git-dir", mirror, "update-ref", ref, ahead);
    await restoreCandidateRef({ ...place, sha: main, signal });
    expect(await git("--git-dir", mirror, "rev-parse", ref)).toBe(main);

    await git("--git-dir", mirror, "update-ref", ref, main);
    await restoreCandidateRef({ ...place, sha: ahead, signal });
    expect(await git("--git-dir", mirror, "rev-parse", ref)).toBe(ahead);

    const unrelated = await git(
      "--git-dir",
      mirror,
      "-c",
      "user.name=acme",
      "-c",
      "user.email=acme@example.com",
      "commit-tree",
      tree,
      "-m",
      "unrelated",
    );
    await expect(restoreCandidateRef({ ...place, sha: unrelated, signal })).rejects.toThrow(
      `Candidate head ${unrelated} of 01ACME does not descend from its base or main`,
    );
    expect(await git("--git-dir", mirror, "rev-parse", ref)).toBe(ahead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
