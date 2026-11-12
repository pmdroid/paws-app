import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { runDir } from "../src/acp";
import { writeAgentSettings, type AgentProfiles } from "../src/config";
import { JOB_KIND, type Clock } from "../src/core";
import { JobLoop, OutboxDispatcher, listJobs, listWorkItems } from "../src/db";
import { createFakeCloseoutGate, type CloseoutVerdict } from "../src/closeout";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { gitIdentity, githubClient } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const FAULT = "reviewer failed for independent-review: opencode has no review command";

function reviewerFault(): CloseoutVerdict {
  const summary = `Closeout: blocked\n${FAULT}`;
  return {
    decision: "blocked",
    exhausted: false,
    summary,
    result: {
      outcome: "blocked",
      taskId: "ENG-1",
      base: "",
      head: "",
      fixAttempts: 0,
      evaluations: 1,
      exitCode: null,
      decision: null,
      summary,
      reviewerFault: FAULT,
    },
  };
}

test("a reviewer fault holds two items with one alert, and a reviewer change re-verifies both into the merge queue", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker(
    ["ENG-1", "ENG-2"].map((identifier) => ({
      linearIssueId: `issue-${identifier}`,
      identifier,
      title: `Task ${identifier}`,
      description: null,
      subIssues: [],
    })),
  );
  const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };
  const { db, close } = await tempStore();
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const gate = createFakeCloseoutGate();
  gate.next = reviewerFault();
  let launches = 0;
  const launch: AgentLaunch = () => {
    launches += 1;
    const scriptPath = path.join(layout.root, `script-${launches}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({ model: "test-model", steps: [{ type: "end", stopReason: "end_turn" }] }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, path.join(layout.root, `result-${launches}.json`), scriptPath],
      env: process.env,
    };
  };
  const github = createFakeGitHub();
  const orchestrator = attachOrchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github),
    }),
    launch,
    closeoutGate: () => gate,
  });
  const drain = async () => {
    while ((await jobs.tick()) !== null);
    for (let round = 0; round < 20; round++) {
      const claimed = await outbox.tick();
      await outbox.idle();
      if (claimed.length === 0) break;
    }
  };
  const holds = async () =>
    (await listJobs(db)).filter(
      (job) =>
        job.queue === JOB_KIND.reverify &&
        job.status === "pending" &&
        "reviewerFault" in (job.payload as object),
    );
  try {
    for (const identifier of ["ENG-1", "ENG-2"])
      await orchestrator.onLinearEvent(created(identifier));
    await db.run((q) => q.exec(q.orm.update(q.t.workItem).set({ delegatedBy: "delegator-1" })));
    await drain();

    const items = await listWorkItems(db);
    expect(items.map((item) => item.state)).toEqual(["verifying", "verifying"]);
    expect((await holds()).map((job) => (job.payload as { itemId: string }).itemId).sort()).toEqual(
      items.map((item) => item.id).sort(),
    );
    for (const hold of await holds()) expect(hold.runAt - hold.createdAt).toBe(60_000);
    for (const session of ["ses_ENG-1", "ses_ENG-2"])
      expect(await findOpenQuestion(db, session)).toBeNull();
    expect(tracker.questions).toEqual([]);
    const alerts = tracker.progress.filter((update) =>
      update.body.includes("can't run its review"),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toContain(FAULT);
    expect(alerts[0]!.body).toContain("ENG-1");
    expect(tracker.progress.map((update) => update.body)).not.toContain(
      "Closeout stopped without a result; retrying in 1 min.",
    );

    const first = items[0]!.id;
    const delays: number[] = [];
    for (let fault = 2; fault <= 5; fault++) {
      const hold = (await holds()).find(
        (job) => (job.payload as { itemId: string }).itemId === first,
      )!;
      await db.run((q) =>
        q.exec(q.orm.update(q.t.job).set({ runAt: 0 }).where(eq(q.t.job.id, hold.id))),
      );
      await jobs.tick([JOB_KIND.reverify]);
      const next = (await holds()).find(
        (job) => (job.payload as { itemId: string }).itemId === first,
      )!;
      delays.push(next.runAt - next.createdAt);
    }
    expect(delays).toEqual([5 * 60_000, 15 * 60_000, 15 * 60_000, 15 * 60_000]);
    await drain();
    expect((await listWorkItems(db)).map((item) => item.state)).toEqual(["verifying", "verifying"]);
    expect(tracker.questions).toEqual([]);
    expect(
      tracker.progress.filter((update) => update.body.includes("can't run its review")),
    ).toHaveLength(1);

    const run = items[0]!.currentRunId!;
    const { profiles } = JSON.parse(
      readFileSync(path.join(runDir(layout.pawsRoot, run), "agent-profile.json"), "utf8"),
    ) as { profiles: AgentProfiles };
    writeAgentSettings(path.join(layout.pawsRoot, "config.toml"), {
      defaults: { ...profiles, reviewer: { agent: "codex", model: "a-working-reviewer" } },
      projects: [],
    });
    gate.next = { decision: "accepted", exhausted: false, summary: "fake accepted" };
    const changed = Date.now();
    await (
      orchestrator as unknown as { reconcileAgentSettings(): Promise<void> }
    ).reconcileAgentSettings();
    const released = (await listJobs(db)).filter(
      (job) => job.queue === JOB_KIND.reverify && job.status === "pending",
    );
    expect(released).toHaveLength(2);
    for (const job of released) {
      expect(job.runAt).toBeGreaterThanOrEqual(changed);
      expect(job.runAt).toBeLessThanOrEqual(Date.now());
      expect(job.payload).not.toHaveProperty("closeoutFaults");
    }
    for (const _ of released) await jobs.tick([JOB_KIND.reverify]);

    expect((await listWorkItems(db)).map((item) => item.state)).toEqual([
      "merge_queue",
      "merge_queue",
    ]);
    expect(tracker.questions).toEqual([]);
  } finally {
    await orchestrator.shutdown();
    await close();
    await layout.cleanup();
  }
}, 90_000);

function created(identifier: string): AcceptedLinearEvent {
  return {
    dedupeKey: `created:${identifier}`,
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: `ses_${identifier}`,
    issueId: `issue-${identifier}`,
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

async function repoLayout() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-reviewer-fault-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await gitIdentity(seed);
  await mkdir(path.join(seed, ".agents"), { recursive: true });
  await writeFile(
    path.join(seed, ".agents", "closeout.yaml"),
    'specVersion: "0.1"\nitems:\n  - id: test\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n',
  );
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return { root, bare, pawsRoot, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}
