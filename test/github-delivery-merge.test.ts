import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { JOB_KIND, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, listJobs, migrate, openDatabase } from "../src/db";
import { createFakeGitHub, fakeMergeReadiness, type GitHubResponse } from "../src/github";
import { createFakeTracker } from "../src/linear";
import { acceptGitHubDelivery, attachOrchestrator } from "../src/loop";
import {
  emptyReview,
  githubClient,
  isMergeReadiness,
  repoLayout,
  stateOf,
  writeOk,
} from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("a green check_suite delivery for the pull request's head merges it before the next poll", async () => {
  const layout = await repoLayout("paws-github-delivery-");
  const tracker = createFakeTracker([
    {
      linearIssueId: "delivery",
      identifier: "ENG-9",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const client = githubClient(layout.bare, createFakeGitHub());
  let green = false;
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
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: {
        async request(req): Promise<GitHubResponse> {
          if (green || !isMergeReadiness(req)) return client.request(req);
          const body = fakeMergeReadiness(
            (req.body as { variables: { head: string } }).variables.head,
          );
          body.data.repository.object.statusCheckRollup.contexts.nodes = [
            { name: "ci", conclusion: null },
          ];
          return { status: 200, body };
        },
      },
    },
    launch(input) {
      sequence += 1;
      const scriptPath = path.join(layout.root, `delivery-${sequence}.json`);
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
  const parkedForCi = () =>
    listJobs(db).find(
      (job) =>
        job.queue === JOB_KIND.merge &&
        job.status === "pending" &&
        job.runAt > Date.now() &&
        typeof (job.payload as { ciWaitHead?: unknown }).ciWaitHead === "string",
    );
  try {
    await orchestrator.onLinearEvent({
      dedupeKey: "created:delivery",
      deliveryId: null,
      source: "webhook",
      action: "created",
      sessionId: "ses_1",
      issueId: "delivery",
      activityId: null,
      actorId: null,
      body: null,
      signal: null,
      updatedAtMs: Date.now(),
      payload: "{}",
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !parkedForCi() && stateOf(db, "ENG-9") !== "failed") {
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
      }
    }
    const parked = parkedForCi();
    expect(parked, stateOf(db, "ENG-9") ?? "").toBeDefined();
    const head = (parked!.payload as { ciWaitHead: string }).ciWaitHead;
    green = true;
    acceptGitHubDelivery(
      db,
      {
        deliveryId: "delivery-1",
        event: "check_suite",
        payload: JSON.stringify({
          action: "completed",
          check_suite: { head_sha: head, status: "completed", conclusion: "success" },
        }),
      },
      Date.now(),
    );
    while (Date.now() < parked!.runAt && stateOf(db, "ENG-9") !== "merged") {
      if ((await jobs.tick()) === null) {
        outbox.tick();
        await Bun.sleep(25);
      }
    }
    expect(stateOf(db, "ENG-9")).toBe("merged");
    expect(Date.now()).toBeLessThan(parked!.runAt);
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 120_000);
