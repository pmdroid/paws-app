import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentResult } from "../src/acp";
import type { Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listRuns,
  migrate,
  openDatabase,
  registerInstance,
  runOwner,
  sqliteDb,
} from "../src/db";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { githubClient } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { cloneRunner } from "./helpers";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("a run the orchestrator starts records the instance that started it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-run-owner-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await writeFile(path.join(seed, "README.md"), "acme\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  const pawsRoot = path.join(root, "paws");
  await mkdir(pawsRoot, { recursive: true });
  const db = openDatabase(path.join(pawsRoot, "paws.db"));
  migrate(db);
  const instance = await registerInstance(sqliteDb(db), {
    role: "all",
    host: "acme",
    version: null,
    now: Date.now(),
  });
  const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ACME-7",
      title: "Widgets",
      description: null,
      subIssues: [],
    },
  ]);
  const repository = { owner: "acme", repo: "widgets" };
  let dispatched = 0;
  const runner = cloneRunner(repository, async (): Promise<RunAgentResult> => {
    dispatched++;
    throw new Error("the fake runner stops after the dispatch");
  });
  const github = createFakeGitHub();
  const orchestrator = attachOrchestrator({
    db,
    instanceId: instance.id,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    pawsRoot,
    tracker,
    publicUrl: "https://paws.example",
    repositories: [{ ...repository, remoteUrl: bare }],
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(bare, github),
    }),
    launch: () => ({ command: "false", args: [], env: process.env }),
    journal: () => {},
    remoteExecution: { agentForItem: () => runner, agentForSession: () => runAgent },
  });
  try {
    await orchestrator.onLinearEvent(created());
    db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
    await jobs.tick();
    expect(dispatched).toBe(1);
    const runs = await listRuns(sqliteDb(db));
    expect(runs).toHaveLength(1);
    expect(runOwner(db, runs[0]!.id)).toBe(instance.id);
  } finally {
    await orchestrator.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

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
