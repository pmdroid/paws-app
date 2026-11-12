import { afterEach, expect, test } from "bun:test";
import {
  appendCloseoutOutput,
  beginImplementRun,
  enqueueOutbox,
  enterMergeQueue,
  finishCloseoutProgress,
  insertQueuedItem,
  joinMergeQueue,
  recordPushOutage,
  savePolicyRunnerWarning,
  upsertCloseoutStep,
  type Db,
} from "../../../db";
import { parseMergeQueueResponse } from "../contract";
import { createLiveStatusProvider } from "./provider";
import { seed } from "../../../../test/dialects";
import { tempStore } from "../../../../test/pglite";
import { queriesDuring } from "../../../../test/query-log";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const DETAIL_TABLES = [
  "closeout_step",
  "closeout_progress",
  "closeout_round",
  "agent_closeout_event",
  "evidence",
  "question",
  "runner_transcript",
  "runner_transcript_chunk",
  "ci_round",
  "candidate_risk",
  "review_finding",
  "visual_review",
];

async function queued(db: Db, id: string, session: string, at: number) {
  const head = "c".repeat(40);
  const item = await insertQueuedItem(db, {
    id,
    title: `Title ${id}`,
    sessionKey: session,
    now: at,
  });
  await beginImplementRun(db, item.id, at);
  await enterMergeQueue(db, item.id, {
    phase: "merge_queue",
    baseSha: head,
    wipCommit: head,
  });
  await enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: session,
    idempotencyKey: `${item.id}:pr:${at}`,
    payload: {
      sessionId: session,
      kind: "response",
      body: `Opened https://github.com/acme/platform/pull/${at}.`,
    },
    now: at,
  });
  await joinMergeQueue(db, {
    itemId: item.id,
    repository: "acme/platform",
    now: at * 10,
  });
  const identity = {
    taskId: item.id,
    base: head,
    head,
    policyDigest: "sha256:p",
    policyPath: null,
  };
  await upsertCloseoutStep(
    db,
    item.id,
    identity,
    {
      id: "test",
      kind: "command",
      state: "failed",
      command: "bun test",
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: at,
      finishedAt: at,
      exitCode: 1,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: null,
      findings: null,
      ordinal: 0,
    },
    at,
  );
  await appendCloseoutOutput(db, item.id, identity, "test", "stderr", "check output", false, at);
  await finishCloseoutProgress(db, item.id, identity, "accepted", at);
}

test("the merge queue reads queue facts, issue summaries and banners for the reader's sessions only", async () => {
  const { db, close } = await tempStore();
  open.push(close);
  const now = Date.now();
  await queued(db, "ENG-1", "ses_mine", 1);
  await queued(db, "ENG-2", "ses_mine", 2);
  await queued(db, "ENG-3", "ses_other", 3);
  await insertQueuedItem(db, { id: "ENG-4", title: "Not merging", sessionKey: "ses_mine", now: 4 });
  await recordPushOutage(db, {
    repository: "acme/platform",
    error: "denied",
    jobId: null,
    installationUrl: null,
    now,
    delayMs: () => 60_000,
  });
  await savePolicyRunnerWarning(db, {
    repository: "acme/platform",
    policyDigest: `sha256:${"a".repeat(64)}`,
    runnerVersion: "0.1.48",
    keys: [{ key: "items[].ci", needs: "0.1.49" }],
    checkedAt: now,
  });
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "w", linearOrganizationId: "org", name: "W", createdAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "w", repository: "acme/platform", teamId: "team" }),
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "ses_mine",
        organizationId: "org",
        oauthClientId: "fixture",
        appUserId: "app",
        teamId: "team",
        installationObservedAt: 1,
        createdAt: 0,
      }),
  );

  const provider = createLiveStatusProvider(db, { sessionIds: ["ses_mine"], env: {} });
  let read: unknown;
  const reads = await queriesDuring(db, async () => (read = await provider.mergeQueue()));
  const parsed = parseMergeQueueResponse(JSON.parse(JSON.stringify(read)));
  if (!parsed.ok) throw new Error(parsed.error);
  const queue = parsed.response;

  expect(queue.entries.map((entry) => [entry.position, entry.itemId, entry.waitingFor])).toEqual([
    [1, "ENG-1", "ci"],
    [2, "ENG-2", "ahead"],
  ]);
  expect(queue.entries[1]?.detail).toBe("Starts when #1 merges");
  expect(queue.issues).toEqual([
    {
      id: "ENG-2",
      title: "Title ENG-2",
      owner: null,
      project: null,
      pr: { number: 2, url: "https://github.com/acme/platform/pull/2" },
    },
    {
      id: "ENG-1",
      title: "Title ENG-1",
      owner: null,
      project: null,
      pr: { number: 1, url: "https://github.com/acme/platform/pull/1" },
    },
  ]);
  expect(queue.pushOutages.map((outage) => outage.repository)).toEqual(["acme/platform"]);
  expect(queue.policyRunnerWarnings.map((warning) => warning.runnerVersion)).toEqual(["0.1.48"]);
  expect(JSON.stringify(queue)).not.toContain("check output");
  for (const table of DETAIL_TABLES)
    expect(reads.join("\n")).not.toMatch(new RegExp(`\\b${table}\\b`));
  const issueReads = await queriesDuring(db, () => provider.issue("ENG-1"));
  expect(issueReads.join("\n")).toMatch(/\bcloseout_step\b/);
});
