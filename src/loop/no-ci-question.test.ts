import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  bindWorkItemRepository,
  enqueueJob,
  enterMergeQueue,
  getJob,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  recordItemPullRequest,
} from "../db";
import {
  fakeMergeReadiness,
  fakeRequiredChecks,
  readPullCi,
  type GitHubBinding,
  type GitHubClient,
} from "../github";
import { MERGE_CI_ASK_AFTER_MS } from "../merge";
import { findOpenQuestion } from "../questions";
import { Orchestrator } from "./orchestrator";

const HEAD = "a".repeat(40);
const SETTING = 'set ci = "none" under [merge.repositories."acme/app"]';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(input: { sessionKey: string | null }) {
  const root = await mkdtemp(join(tmpdir(), "paws-no-ci-question-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  const client: GitHubClient = {
    request: async (request) => {
      if (request.path === "/graphql") {
        const body = fakeMergeReadiness(HEAD);
        body.data.repository.object.statusCheckRollup.contexts.nodes = [];
        body.data.repository.pullRequest.baseRef.target.statusCheckRollup.contexts.nodes = [];
        return { status: 200, body };
      }
      const answer = fakeRequiredChecks(request);
      if (!answer) throw new Error(`unexpected request ${request.method} ${request.path}`);
      return answer;
    },
  };
  const github: GitHubBinding = {
    appId: "1",
    installationId: "2",
    privateKeyPem: "unused",
    tokenProvider: { mode: "token", tokenFor: async () => "fake-token" },
    client,
  };
  const jobs = new JobLoop(db, clock);
  const orchestrator = new Orchestrator({
    db,
    clock,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    githubForRepository: () => github,
  });
  orchestrator["merge"] = async () => {
    const ci = await readPullCi({
      client,
      owner: "acme",
      repo: "app",
      prNumber: 7,
      head: HEAD,
      ci: orchestrator["repositoryCi"]("acme/app"),
      tokenProvider: github.tokenProvider,
    });
    if (ci.state !== "pending") throw new Error(`expected pending CI, got ${ci.state}`);
    return { kind: "wait", reason: "ci", message: ci.message, head: HEAD };
  };
  insertQueuedItem(db, { id: "ENG-7", sessionKey: input.sessionKey ?? "unused", now: clock.now() });
  if (input.sessionKey === null)
    db.run("UPDATE work_item SET session_key = NULL WHERE id = 'ENG-7'");
  bindWorkItemRepository(db, "ENG-7", {
    owner: "acme",
    repo: "app",
    remoteUrl: "https://github.com/acme/app.git",
  });
  beginImplementRun(db, "ENG-7", clock.now());
  enterMergeQueue(db, "ENG-7", { phase: "merge_queue", wipCommit: HEAD });
  markCloseoutAccepted(db, "ENG-7", HEAD);
  recordItemPullRequest(db, {
    itemId: "ENG-7",
    pullNumber: 7,
    pullUrl: "https://github.com/acme/app/pull/7",
    openedAt: clock.now(),
  });
  const job = enqueueJob(db, {
    queue: JOB_KIND.merge,
    payload: { itemId: "ENG-7", head: HEAD },
    now: clock.now(),
  });
  cleanups.push(async () => {
    await orchestrator.shutdown();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, clock, jobs, job };
}

async function waitSixHours(f: Awaited<ReturnType<typeof fixture>>) {
  await f.jobs.tick([JOB_KIND.merge]);
  expect(getJob(f.db, f.job)?.payload).toMatchObject({
    mergeWait: { reason: "ci", message: expect.stringContaining(SETTING) },
  });
  expect(getWorkItem(f.db, "ENG-7")?.state).toBe("merge_queue");
  f.clock.advance(MERGE_CI_ASK_AFTER_MS);
  await f.jobs.tick([JOB_KIND.merge]);
}

test('a ci = "required" repository with no check for six hours asks a question that names the setting', async () => {
  const f = await fixture({ sessionKey: "ses_7" });
  await waitSixHours(f);
  expect(getWorkItem(f.db, "ENG-7")?.state).toBe("awaiting_input");
  const question = findOpenQuestion(f.db, "ses_7");
  expect(question).toMatchObject({
    reason: "ci_slow",
    options: ["Merge the accepted work", "Stop"],
  });
  expect(question!.body).toStartWith(
    "No GitHub CI check has reported on the accepted head in 6 hours; merge or stop?",
  );
  expect(question!.body).toContain(SETTING);
  expect(question!.body).toContain('after ci = "none" is set for the repository');
});

test("a no-check merge wait that cannot ask fails with a message that names the setting", async () => {
  const f = await fixture({ sessionKey: null });
  await waitSixHours(f);
  expect(getWorkItem(f.db, "ENG-7")?.state).toBe("failed");
  const errors = listOutbox(f.db).map((row) => row.payload as { kind?: string; body?: string });
  expect(errors.find((payload) => payload.kind === "error")?.body).toContain(
    `merge timed out waiting for GitHub: No CI checks reported yet. If acme/app has no CI, ${SETTING}`,
  );
});
