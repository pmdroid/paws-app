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
import { createFakeGitHubComments, type GitHubCommentMethod } from "../src/ghcomments";
import { createGitHubCommentIngestor, openGitHubWork } from "../src/index";
import { attachOrchestrator } from "../src/loop";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const epicIssue = "github:local/fixture#1";
const childIssue = "github:local/fixture#2";

for (const target of ["child", "epic", "epic-before-progress"] as const) {
  test(`trusted ${target} stop cancels the owned implementation through production comments`, async () => {
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
    db.run("UPDATE epic SET linear_issue_id = ? WHERE id = ?", [epicIssue, item.epicId]);
    db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", [childIssue, item.id]);
    const sibling = insertQueuedItem(db, { id: "durable-sibling", sessionKey: epicIssue });
    db.run("UPDATE work_item SET epic_id = ?, linear_issue_id = ? WHERE id = ?", [
      item.epicId,
      "github:local/fixture#3",
      sibling.id,
    ]);
    const merged = insertQueuedItem(db, { id: "durable-merged", sessionKey: epicIssue });
    db.run("UPDATE work_item SET epic_id = ?, state = 'merged' WHERE id = ?", [
      item.epicId,
      merged.id,
    ]);
    const unrelated = insertQueuedItem(db, { id: "unrelated" });
    const clock = new FakeClock(Date.now());
    const comments = createFakeGitHubComments({ clock, selfLogin: "maintainer" });
    const work = openGitHubWork({
      provider: {
        source: "oauth",
        token: async () => "fixture",
        user: async () => ({ login: "maintainer", id: 1 }),
      },
      owner: "local",
      repo: "fixture",
      clock,
      labels: false,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const response = await comments.request({
          method: (init?.method ?? "GET") as GitHubCommentMethod,
          path: `${url.pathname}${url.search}`,
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
        });
        return new Response(JSON.stringify(response.body), { status: response.status });
      },
    });
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
      tracker: work.tracker,
      repository: { owner: "local", repo: "fixture", remoteUrl: bare },
      channel: "comments",
      launch: () => ({
        command: process.execPath,
        args: [wrapper],
        env: { ...process.env, FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_RESULT: resultPath },
      }),
    });
    const submitted: string[] = [];
    const ingest = createGitHubCommentIngestor(
      db,
      work.comments,
      (event) => orchestrator.onLinearEvent(event),
      (command) => {
        submitted.push(command.itemId);
        submitCommand(db, orchestrator.bus, command);
      },
    );
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
            comments: comments.calls,
          }),
      );
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(alive(pid)).toBe(true);
      expect(getWorkItem(db, item.id)?.state).toBe("running");
      const issueId = target === "child" ? childIssue : epicIssue;
      const issueNumber = target === "child" ? 2 : 1;
      if (target === "epic-before-progress") await ingest(issueId);
      else
        await work.tracker.postProgress({ sessionId: issueId, kind: "thought", body: "Working" });
      clock.advance(1_000);
      comments.post({ issueNumber, login: "outsider", association: "NONE", body: "/paws stop" });
      await ingest(issueId);
      expect(submitted).toEqual([]);
      expect(getWorkItem(db, item.id)?.state).toBe("running");
      expect(alive(pid)).toBe(true);
      clock.advance(1_000);
      comments.post({ issueNumber, login: "member", association: "MEMBER", body: "/paws stop" });
      await ingest(issueId);
      const observed = {
        target,
        submitted,
        item: getWorkItem(db, item.id)?.state,
        sibling: getWorkItem(db, sibling.id)?.state,
        phase: work.comments.phase(issueId),
        processAlive: alive(pid),
      };
      console.log("stop observation", JSON.stringify(observed));
      expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
      expect(getWorkItem(db, item.id)?.cancelRequested).toBe(true);
      expect(submitted).toEqual(target === "child" ? [item.id] : [item.id, sibling.id]);
      expect(getWorkItem(db, sibling.id)?.state).toBe(target === "child" ? "queued" : "cancelled");
      expect(getWorkItem(db, unrelated.id)?.state).toBe("queued");
      expect(getWorkItem(db, merged.id)?.state).toBe("merged");
      expect(
        db
          .query<{ state: string }, [string]>("SELECT state FROM epic WHERE id = ?")
          .get(item.epicId)?.state,
      ).toBe(target === "child" ? "running" : "cancelled");
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
      await ingest(issueId);
      expect(submitted).toHaveLength(target === "child" ? 1 : 2);
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
