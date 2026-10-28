import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getPushOutage,
  listJobs,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeGitHub, defaultGitExec, GitCommandError, type GitExec } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { emptyReview, githubClient, repoLayout, stateOf, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const DENIED =
  "remote: Permission to pmdroid/paws-demo.git denied to paws-helper[bot].\nfatal: unable to access 'https://github.com/pmdroid/paws-demo.git/': The requested URL returned error: 403";
const WORKFLOWS =
  "To https://github.com/pmdroid/paws-demo.git\n ! [remote rejected] HEAD -> paws/eng-9 (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\nerror: failed to push some refs to 'https://github.com/pmdroid/paws-demo.git'";

test("a push GitHub denies to the App holds the candidate push and merges once pushes work", async () => {
  const run = await delegate(DENIED);
  try {
    await run.until(() => getPushOutage(run.db, "pmdroid/paws-demo") !== null);
    // Further passes over the held merge job neither fail the item nor ask anyone.
    await run.until(() => run.refusals >= 3, () => run.probeNow());
    expect(stateOf(run.db, "ENG-9"), run.detail()).toBe("merge_queue");
    expect(run.progress("elicitation"), run.detail()).toEqual([]);
    expect(run.progress("error"), run.detail()).toEqual([]);
    const merge = listJobs(run.db).find((job) => job.queue === JOB_KIND.merge)!;
    expect(merge.status, run.detail()).toBe("pending");
    expect(merge.attempts, run.detail()).toBe(0);
    expect(merge.payload).toMatchObject({ mergeWait: { reason: "push_outage" } });
    expect(getPushOutage(run.db, "pmdroid/paws-demo")).toMatchObject({
      lastError: DENIED,
      installationUrl: "https://github.com/settings/installations/2",
    });

    run.refuse(null);
    run.probeNow();
    await run.until(() => stateOf(run.db, "ENG-9") === "merged");
    expect(getPushOutage(run.db, "pmdroid/paws-demo")).toBeNull();
    expect(run.progress("elicitation"), run.detail()).toEqual([]);
    expect(run.progress("error"), run.detail()).toEqual([]);
  } finally {
    await run.cleanup();
  }
}, 120_000);

test("a refusal for the workflows permission is no push outage and fails the item as before", async () => {
  const run = await delegate(WORKFLOWS);
  try {
    await run.until(
      () => stateOf(run.db, "ENG-9") === "failed",
      () =>
        run.db.run("UPDATE job SET max_attempts = 2 WHERE queue = ? AND status = 'pending'", [
          JOB_KIND.merge,
        ]),
    );
    expect(getPushOutage(run.db, "pmdroid/paws-demo")).toBeNull();
    expect(run.progress("elicitation"), run.detail()).toEqual([]);
    expect(run.progress("error").join("\n"), run.detail()).toContain(
      "without `workflows` permission",
    );
  } finally {
    await run.cleanup();
  }
}, 120_000);

async function delegate(refusal: string) {
  const layout = await repoLayout("paws-push-outage-");
  const tracker = createFakeTracker([
    {
      linearIssueId: "outage",
      identifier: "ENG-9",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock, { backoffBaseMs: 10 });
  const outbox = new OutboxDispatcher(db, systemClock);
  let refused: string | null = refusal;
  let refusals = 0;
  const git = defaultGitExec();
  const gitExec: GitExec = async (args, options) => {
    if (args.includes("push") && refused !== null) {
      refusals += 1;
      throw new GitCommandError(args, refused);
    }
    return git(args, options);
  };
  let sequence = 0;
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    retryBaseMs: 10,
    publicationGitExec: gitExec,
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, createFakeGitHub()),
    },
    launch(input) {
      sequence += 1;
      const scriptPath = path.join(layout.root, `outage-${sequence}.json`);
      const steps: FakeScript["steps"] =
        input.purpose === "implement"
          ? [writeOk(input.worktree), { type: "end" }]
          : emptyReview().steps;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
    },
  });
  await orchestrator.onLinearEvent(linearEvent());
  const progress = (kind: string) =>
    tracker.progress.filter((update) => update.kind === kind).map((update) => update.body);
  return {
    db,
    get refusals() {
      return refusals;
    },
    refuse(next: string | null) {
      refused = next;
    },
    /** The probe's backoff has passed. */
    probeNow() {
      db.run("UPDATE job SET run_at = 0 WHERE queue = ? AND status = 'pending'", [JOB_KIND.merge]);
    },
    progress,
    async until(done: () => boolean, each?: () => void) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !done()) {
        each?.();
        if ((await jobs.tick()) === null) {
          outbox.tick();
          await Bun.sleep(25);
        }
      }
      while (outbox.tick().length > 0) await outbox.idle();
      expect(done(), this.detail()).toBe(true);
    },
    detail: () =>
      JSON.stringify({
        state: stateOf(db, "ENG-9"),
        jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
      }),
    async cleanup() {
      await orchestrator.shutdown().catch(() => undefined);
      db.close();
      await layout.cleanup();
    },
  };
}

function linearEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:outage",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "outage",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
