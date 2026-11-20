import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { FakeClock, type GitCommitPolicy } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  recordItemCandidate,
  saveCheckpoint,
  type WorkItemRecord,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempStore } from "./pglite";

const BOT = { appId: "99", id: 88, login: "paws-test[bot]" };
const policy: GitCommitPolicy = { bot: BOT, credit: null };
const person = { name: "Rita", email: "rita@acme.test" };
const bot = { name: "paws-test[bot]", email: "88+paws-test[bot]@users.noreply.github.com" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Internals = {
  validateAttribution(
    item: WorkItemRecord,
    tree: string,
    base: string,
    head: string,
    policy: GitCommitPolicy,
  ): Promise<void>;
  adoptBranchArrivals(item: WorkItemRecord, signal: AbortSignal): Promise<string>;
  branchRead: (item: WorkItemRecord) => Promise<unknown>;
  restoreCandidate: (item: WorkItemRecord) => Promise<void>;
};

async function setup(remote: boolean) {
  const root = mkdtempSync(join(tmpdir(), "paws-adopted-"));
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: root,
    tracker: createFakeTracker(),
    repositories: [{ owner: "acme", repo: "app", remoteUrl: join(root, "origin.git") }],
    async commitPolicyForItem() {
      return policy;
    },
    ...(remote
      ? {
          remoteExecution: {
            agentForSession() {
              throw new Error("unused");
            },
            agentForItem() {
              throw new Error("unused");
            },
          },
        }
      : {}),
  });
  cleanups.push(async () => {
    await orchestrator.shutdown();
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  await insertQueuedItem(db, { id: "task", sessionKey: "session", now: 1_000 });
  await beginImplementRun(db, "task", 1_000);
  return { root, db, internals: orchestrator as unknown as Internals };
}

test("an adopted person's commit passes attribution while later commits are still checked", async () => {
  const { root, db, internals } = await setup(false);
  const tree = join(root, "tree");
  const run = (args: string[], who = person) =>
    git(["-C", tree, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
      },
    });
  const commit = async (file: string, who = person) => {
    writeFileSync(join(tree, file), file);
    await run(["add", "."], who);
    await run(["commit", "-qm", file], who);
    return (await run(["rev-parse", "HEAD"])).trim();
  };
  await git(["init", "-q", "-b", "main", tree]);
  const base = await commit("base.txt");
  const theirs = await commit("theirs.txt");
  const agent = await commit("agent.txt", bot);
  const validate = async (head: string) =>
    internals.validateAttribution((await getWorkItem(db, "task"))!, tree, base, head, policy);

  await expect(validate(agent)).rejects.toThrow("attribution rejected");
  await saveCheckpoint(db, "task", { phase: "running", adopted: [theirs] });
  await saveCheckpoint(db, "task", { phase: "verifying", baseSha: base, wipCommit: agent });
  expect((await getWorkItem(db, "task"))?.checkpoint?.adopted).toEqual([theirs]);
  await validate(agent);
  const later = await commit("later.txt");
  await expect(validate(later)).rejects.toThrow("attribution rejected");
});

test("a retry after the adopted tip was recorded still restores the mirror candidate", async () => {
  const { db, internals } = await setup(true);
  const tip = "c".repeat(40);
  await recordItemCandidate(db, { itemId: "task", sha: tip, branch: "paws/task", recordedAt: 1 });
  const restored: string[] = [];
  internals.branchRead = async () => ({ read: { branch: "paws/task" }, tip });
  internals.restoreCandidate = async (item) => {
    restored.push(item.id);
  };
  const prompt = await internals.adoptBranchArrivals(
    (await getWorkItem(db, "task"))!,
    new AbortController().signal,
  );
  expect(prompt).toBe("");
  expect(restored).toEqual(["task"]);
});
