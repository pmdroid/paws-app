import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND, systemClock } from "../src/core";
import {
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listJobs,
  migrate,
  openDatabase,
  OutboxDispatcher,
  submitCommand,
} from "../src/db";
import { createCommentMode, createFakeCommentBoard } from "../src/comments";
import { createFakeTracker } from "../src/linear";
import { commentTracker, syncComments } from "../src/index";
import { attachOrchestrator } from "../src/loop";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const epicIssue = "epic-1";
const childIssue = "child-2";

for (const target of ["child", "child-before-progress"] as const) {
  test(`Linear ${target} stop cancels the owned implementation through production comments`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paws-stop-"));
    const seed = path.join(root, "seed");
    const bare = path.join(root, "origin.git");
    const pawsRoot = path.join(root, "paws");
    await mkdir(pawsRoot);
    await exec("git", ["init", "--bare", "-b", "main", bare]);
    await exec("git", ["clone", bare, seed]);
    await exec("git", ["-C", seed, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", seed, "config", "user.name", "Test"]);
    await writeFile(path.join(seed, "README.md"), "fixture\n");
    await exec("git", ["-C", seed, "add", "."]);
    await exec("git", ["-C", seed, "-c", "commit.gpgsign=false", "commit", "-m", "seed"]);
    await exec("git", ["-C", seed, "push", "origin", "main"]);
    const db = openDatabase(path.join(pawsRoot, "paws.db"));
    migrate(db);
    const item = insertQueuedItem(db, { id: "durable-child", sessionKey: epicIssue });
    db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", [childIssue, item.id]);
    const sibling = insertQueuedItem(db, { id: "durable-sibling", sessionKey: epicIssue });
    db.run("UPDATE work_item SET delegation_id = ?, linear_issue_id = ? WHERE id = ?", [
      item.epicId,
      "child-3",
      sibling.id,
    ]);
    const merged = insertQueuedItem(db, { id: "durable-merged", sessionKey: epicIssue });
    db.run("UPDATE work_item SET delegation_id = ?, state = 'merged' WHERE id = ?", [
      item.epicId,
      merged.id,
    ]);
    const unrelated = insertQueuedItem(db, { id: "unrelated" });
    const clock = new FakeClock(Date.now());
    const comments = createFakeCommentBoard({ clock, selfUserId: "maintainer" });
    const mode = createCommentMode({ board: comments, clock, selfUserId: "maintainer" });
    const tracker = commentTracker(db, createFakeTracker(), mode);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const resultPath = path.join(root, "agent-result.json");
    const pidPath = path.join(root, "agent.pid");
    const scriptPath = path.join(root, "script.json");
    writeFileSync(scriptPath, JSON.stringify({ steps: [{ type: "hang" }] }));
    const wrapper = path.join(root, "fake-agent.ts");
    await writeFile(
      wrapper,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nawait import(${JSON.stringify(fakeAgent)});\n`,
    );
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot,
      tracker,
      repository: { owner: "local", repo: "fixture", remoteUrl: bare },
      channel: "comments",
      launch: () => ({
        command: process.execPath,
        args: [wrapper, resultPath, scriptPath],
        env: { ...process.env, FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_RESULT: resultPath },
      }),
    });
    const ingest = () => syncComments(db, mode, orchestrator);
    let running: Promise<unknown> | null = null;
    try {
      enqueueJob(db, {
        queue: JOB_KIND.start,
        jobKey: `start:${item.id}`,
        payload: { itemId: item.id },
        now: Date.now(),
      });
      running = jobs.tick();
      await waitFor(
        () => existsSync(resultPath) && readFileSync(resultPath, "utf8").includes("session/prompt"),
        () =>
          JSON.stringify({
            item: getWorkItem(db, item.id),
            jobs: listJobs(db),
            comments: comments.comments,
          }),
      );
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(alive(pid)).toBe(true);
      expect(getWorkItem(db, item.id)?.state).toBe("running");
      const issueId = childIssue;
      if (target === "child-before-progress") await ingest();
      else await tracker.postProgress({ sessionId: issueId, kind: "thought", body: "Working" });
      clock.advance(1_000);
      comments.post({ issueId, userId: "member", body: "/paws stop" });
      await ingest();
      const observed = {
        target,
        item: getWorkItem(db, item.id)?.state,
        sibling: getWorkItem(db, sibling.id)?.state,
        phase: mode.phase(item.id),
        processAlive: alive(pid),
      };
      console.log("stop observation", JSON.stringify(observed));
      expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
      expect(getWorkItem(db, item.id)?.cancelRequested).toBe(true);
      expect(getWorkItem(db, sibling.id)?.state).toBe("queued");
      expect(getWorkItem(db, unrelated.id)?.state).toBe("queued");
      expect(getWorkItem(db, merged.id)?.state).toBe("merged");
      await waitFor(() => !alive(pid));
      await running;
      running = null;
      expect(JSON.parse(readFileSync(resultPath, "utf8")).methods).toContain("session/cancel");
      expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
      expect(
        listJobs(db).filter(
          (job) => job.queue === JOB_KIND.reverify || job.queue === JOB_KIND.merge,
        ),
      ).toEqual([]);
      await ingest();
      console.log(
        "stop treatment",
        JSON.stringify({
          target,
          item: getWorkItem(db, item.id)?.state,
          processAlive: alive(pid),
          cancellation: "session/cancel",
        }),
      );
    } finally {
      submitCommand(db, orchestrator.bus, {
        type: "stop",
        itemId: item.id,
        source: "linear",
        requestedAt: Date.now(),
      });
      await running;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, debug?: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate(), debug?.()).toBe(true);
}
