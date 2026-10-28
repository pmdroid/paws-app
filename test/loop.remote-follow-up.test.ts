import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  enqueueOutboxOnce,
  getLinearSessionGeneration,
  getRun,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { workspaceAdmission } from "./fake-workspace";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

for (const delivered of [true, false, "completed"] as const)
  test(`a Linear reply during a run handles forwarding with prior completion: ${delivered}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paws-remote-follow-up-"));
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
    await writeFile(path.join(seed, "README.md"), "demo\n");
    await exec("git", ["-C", seed, "add", "."]);
    await exec("git", ["-C", seed, "commit", "-m", "init"]);
    await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
    const db = openDatabase(path.join(pawsRoot, "paws.db"));
    migrate(db);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-7",
        title: "Build the gallery",
        description: null,
        subIssues: [],
      },
    ]);
    let scripts = 0;
    const launch: AgentLaunch = () => {
      const script = path.join(root, `script-${++scripts}.json`);
      writeFileSync(
        script,
        JSON.stringify({ model: "test-claude-model", steps: [{ type: "hang" }] }),
      );
      return {
        command: process.execPath,
        args: [fakeAgent, path.join(root, `result-${scripts}.json`), script],
        env: process.env,
      };
    };
    const forwarded: { itemId: string; body: string }[] = [];
    const orchestrator = attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      outbox,
      pawsRoot,
      home,
      tracker,
      repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: bare }],
      githubForRepository: () => ({
        appId: "1",
        installationId: "2",
        privateKeyPem: "unused",
        client: {
          async request() {
            return { status: 404, body: {} };
          },
        },
      }),
      launch,
      remoteFollowUp(itemId, body) {
        forwarded.push({ itemId, body });
        return delivered !== false;
      },
    });
    try {
      await orchestrator.onLinearEvent(event("created", null));
      const running = jobs.tick();
      const item = listWorkItems(db)[0]!;
      for (let attempt = 0; attempt < 500; attempt++) {
        const current = listWorkItems(db)[0]!;
        if (current.currentRunId && getRun(db, current.currentRunId)?.status === "active") break;
        await Bun.sleep(10);
      }
      const runId = listWorkItems(db)[0]!.currentRunId!;
      if (delivered === "completed") {
        enqueueOutboxOnce(db, {
          target: "linear",
          op: "activity",
          orderingKey: "ses_1",
          delivery: "ordered",
          idempotencyKey: `pull-request-ready:${item.id}:${getLinearSessionGeneration(db, "ses_1")}`,
          payload: { sessionId: "ses_1", kind: "response", body: "Opened pull request #1." },
        });
        while (outbox.tick().length > 0) await outbox.idle();
        expect(tracker.progress.at(-1)?.kind).toBe("response");
      }
      await orchestrator.onLinearEvent(event("prompted", "Also cover the empty state"));
      expect(forwarded).toEqual(
        delivered === "completed" ? [] : [{ itemId: item.id, body: "Also cover the empty state" }],
      );
      const resumes = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
      if (delivered === true) {
        expect(getRun(db, runId)?.status).toBe("active");
        expect(listWorkItems(db)[0]!.currentRunId).toBe(runId);
        expect(resumes).toHaveLength(0);
        await orchestrator.onLinearEvent({ ...event("prompted", null), signal: "stop" });
      } else {
        expect(resumes).toHaveLength(1);
        expect(tracker.progress.at(-1)).toMatchObject({
          kind: "thought",
          body: "Received your update.",
        });
      }
      await running;
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

function event(action: "created" | "prompted", body: string | null): AcceptedLinearEvent {
  return {
    dedupeKey: action === "created" ? "created:issue" : `activity:${body ?? "stop"}`,
    deliveryId: null,
    source: "webhook",
    action,
    sessionId: "ses_1",
    issueId: "issue",
    activityId: action === "created" ? null : `act-${body ?? "stop"}`,
    actorId: action === "created" ? null : "human-1",
    body,
    signal: null,
    updatedAtMs: Date.now() + (action === "created" ? 0 : 1_000),
    payload: "{}",
  };
}
