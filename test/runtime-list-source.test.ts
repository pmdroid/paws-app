import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { ensureBareMirror, runAgent } from "../src/acp";
import type { TaskMode } from "../src/core";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindWorkItemRepository,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  saveTaskMode,
  type WorkItemRecord,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import type { RuntimeList } from "../src/runtimes";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });

async function repositoryWithStaleMirror() {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-list-source-"));
  roots.push(root);
  const remoteUrl = join(root, "origin.git");
  const seed = join(root, "seed");
  const pawsRoot = join(root, "paws");
  mkdirSync(pawsRoot);
  git("init", "--bare", "-b", "main", remoteUrl);
  git("clone", remoteUrl, seed);
  const pin = async (version: string) => {
    writeFileSync(join(seed, "mise.toml"), `[tools]\nbun = "${version}"\n`);
    git("-C", seed, "add", ".");
    git(
      "-C",
      seed,
      "-c",
      "user.name=Paws Test",
      "-c",
      "user.email=paws@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      `Pin bun ${version}`,
    );
    git("-C", seed, "push", "origin", "HEAD:main");
  };
  const repository = { owner: "acme", repo: "widgets", remoteUrl };
  await pin("1.0.0");
  await ensureBareMirror({ ...repository, pawsRoot });
  await pin("2.0.0");
  return { root, pawsRoot, seed, repository };
}

async function runtimesFor(
  fixture: Awaited<ReturnType<typeof repositoryWithStaleMirror>>,
  options: { mode: TaskMode; remote: boolean; worktreePath: string },
): Promise<RuntimeList | undefined> {
  const db = openDatabase(join(fixture.root, "paws.db"));
  migrate(db);
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: fixture.pawsRoot,
    tracker: createFakeTracker(),
    repositories: [fixture.repository],
    ...(options.remote
      ? { remoteExecution: { agentForItem: () => runAgent, agentForSession: () => runAgent } }
      : {}),
  });
  try {
    insertQueuedItem(db, { id: "task", sessionKey: "session", now: 1_000 });
    bindWorkItemRepository(db, "task", fixture.repository);
    saveTaskMode(db, "task", options.mode);
    const inputs = await (
      orchestrator as unknown as {
        trustedRunInputs(
          item: WorkItemRecord,
          input: { role: string; worktreePath: string; readOnly: boolean },
        ): Promise<{ runtimes?: () => Promise<RuntimeList> }>;
      }
    ).trustedRunInputs(getWorkItem(db, "task")!, {
      role: "implementer",
      worktreePath: options.worktreePath,
      readOnly: options.mode !== "code",
    });
    return await inputs.runtimes?.();
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
}

test("a runner-backed answer task reads the runtimes from the shared mirror, not its task folder", async () => {
  const fixture = await repositoryWithStaleMirror();
  const taskFolder = join(fixture.pawsRoot, "tasks", "task", "answer");
  mkdirSync(taskFolder, { recursive: true });
  expect(
    await runtimesFor(fixture, { mode: "answer", remote: true, worktreePath: taskFolder }),
  ).toEqual({ runtimes: [{ tool: "bun", version: "1.0.0" }], notices: [] });
}, 60_000);

test("a runner-backed code task still reads the runtimes from the shared mirror", async () => {
  const fixture = await repositoryWithStaleMirror();
  const noCheckout = join(fixture.root, "no-checkout");
  mkdirSync(noCheckout);
  expect(
    await runtimesFor(fixture, { mode: "code", remote: true, worktreePath: noCheckout }),
  ).toEqual({ runtimes: [{ tool: "bun", version: "1.0.0" }], notices: [] });
}, 60_000);

test("a local answer task still reads the runtimes from its worktree", async () => {
  const fixture = await repositoryWithStaleMirror();
  expect(
    await runtimesFor(fixture, { mode: "answer", remote: false, worktreePath: fixture.seed }),
  ).toEqual({ runtimes: [{ tool: "bun", version: "2.0.0" }], notices: [] });
}, 60_000);
