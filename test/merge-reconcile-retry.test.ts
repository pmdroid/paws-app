import { syncSteps } from "../src/runner-backend";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { JOB_KIND, systemClock } from "../src/core";
import { and, count, eq } from "drizzle-orm";
import { JobLoop, OutboxDispatcher, listJobs } from "../src/db";
import { createFakeGitHub } from "../src/github";
import {
  createItemReconciler,
  createPublicationReadiness,
  hasPendingDelegationChanges,
} from "../src/intake";
import {
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  type AcceptedLinearEvent,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { emptyReview, githubClient, repoLayout, stateOfPg, writeOk } from "./e2e-harness";
import { seed } from "./dialects";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("a merge attempt reconciles a request a Linear 503 left pending and merges", async () => {
  const run = await delegate(1);
  try {
    await run.until(async () => (await stateOfPg(run.db, "ACME-1")) === "merged");
    expect(run.failedReads(), await run.detail()).toBe(1);
    expect(await run.implementRuns(), await run.detail()).toBe(1);
    expect(run.github.merged).toHaveLength(1);
    expect(run.lines.filter((line) => line.includes("reconciles pending Linear changes"))).toEqual([
      "item ACME-1: a merge attempt reconciles pending Linear changes",
    ]);
  } finally {
    await run.cleanup();
  }
}, 120_000);

test("a reconcile that keeps failing holds the item in the merge queue without merging", async () => {
  const run = await delegate(Number.POSITIVE_INFINITY);
  try {
    await run.until(async () => run.failedReads() >= 3);
    expect(await stateOfPg(run.db, "ACME-1"), await run.detail()).toBe("merge_queue");
    expect(await hasPendingDelegationChanges(run.db, run.delegationId), await run.detail()).toBe(
      true,
    );
    expect(
      (await listJobs(run.db)).some(
        (job) => job.queue === JOB_KIND.merge && job.status === "pending",
      ),
      await run.detail(),
    ).toBe(true);
    expect(run.github.merged).toEqual([]);
    expect(await run.implementRuns(), await run.detail()).toBe(1);
  } finally {
    await run.cleanup();
  }
}, 120_000);

async function delegate(failures: number) {
  const layout = await repoLayout("paws-merge-reconcile-");
  const tracker = createFakeTracker([
    {
      linearIssueId: "acme-issue",
      identifier: "ACME-1",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const { db, close } = await tempStore();
  const jobs = new JobLoop(db, systemClock, { backoffBaseMs: 10 });
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
  const admission = workspaceAdmission(db);
  let left = failures;
  let failed = 0;
  const reconciler = createItemReconciler({
    store: db,
    tracker: {
      async loadEpic(id) {
        if ((await stateOfPg(db, "ACME-1")) === "merge_queue" && left > 0) {
          left -= 1;
          failed += 1;
          throw new Error("Linear GraphQL HTTP 503");
        }
        return tracker.loadEpic(id);
      },
      listDeps: (id) => tracker.listDeps(id),
      listBlockers: tracker.listBlockers?.bind(tracker),
    },
    lifecycle: createFakeLinearIssueLifecycle({
      id: "acme-issue",
      teamId: "team",
      stateType: "started",
      assigneeId: "acme-human",
      delegateId: "app",
    }),
    onChanges: () => syncSteps(() => {}),
  });
  const publication = createPublicationReadiness({
    store: db,
    reconciler,
    canMerge: async (itemId) => (await admission.canMerge(itemId)).ok,
  });
  const lines: string[] = [];
  let sequence = 0;
  const orchestrator = attachOrchestrator({
    store: db,
    admission,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repositories: [{ owner: "acme", repo: "widgets", remoteUrl: layout.bare }],
    retryBaseMs: 10,
    journal: (line) => lines.push(line),
    publicationReady: (...args) => publication.publicationReady(...args),
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github, [], { owner: "acme", repo: "widgets" }),
    }),
    launch(input) {
      sequence += 1;
      const scriptPath = path.join(layout.root, `reconcile-${sequence}.json`);
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
  // Intake's first reconcile, which records the item's specification.
  const [item] = await db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.workItem.id, delegationId: q.t.workItem.delegationId })
        .from(q.t.workItem)
        .where(eq(q.t.workItem.linearIdentifier, "ACME-1")),
    ),
  );
  if (!item) throw new Error("ACME-1 was not taken in");
  await admission.canDispatchDelegation(item.delegationId);
  const [workspace] = await db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.workspace.id })
        .from(q.t.workItem)
        .innerJoin(q.t.linearSession, eq(q.t.linearSession.sessionId, q.t.workItem.sessionKey))
        .innerJoin(
          q.t.workspace,
          eq(q.t.workspace.linearOrganizationId, q.t.linearSession.organizationId),
        )
        .where(eq(q.t.workItem.id, item.id)),
    ),
  );
  const workspaceId = workspace!.id;
  await reconciler.reconcile({ itemId: item.id, workspaceId });
  return {
    db,
    github,
    lines,
    failedReads: () => failed,
    delegationId: item.delegationId,
    implementRuns: async () =>
      (
        await db.run((q) =>
          q.all(q.orm.select({ n: count() }).from(q.t.run).where(eq(q.t.run.kind, "implement"))),
        )
      )[0]!.n,
    async until(done: () => Promise<boolean>) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !(await done())) {
        await seed(db, (q) =>
          q.orm
            .update(q.t.job)
            .set({ runAt: 0 })
            .where(and(eq(q.t.job.queue, JOB_KIND.merge), eq(q.t.job.status, "pending"))),
        );
        if ((await jobs.tick()) === null) {
          await outbox.tick();
          await Bun.sleep(25);
        }
      }
      while ((await outbox.tick()).length > 0) await outbox.idle();
      expect(await done(), await this.detail()).toBe(true);
    },
    detail: async () =>
      JSON.stringify({
        state: await stateOfPg(db, "ACME-1"),
        failed,
        jobs: (await listJobs(db)).map(
          (job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`,
        ),
        lines: lines.slice(-20),
      }),
    async cleanup() {
      await orchestrator.shutdown().catch(() => undefined);
      await reconciler.close();
      await close();
      await layout.cleanup();
    },
  };
}

function linearEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:acme-issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "acme-session",
    issueId: "acme-issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
