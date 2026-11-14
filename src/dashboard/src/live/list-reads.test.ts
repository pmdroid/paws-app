import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  recordConfirmedRemoteMerge,
  startUsagePause,
  type Db,
} from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { seed } from "../../../../test/dialects";
import { tempStore } from "../../../../test/pglite";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const HEAD = "a".repeat(40);

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  setSystemTime();
  for (const close of open.splice(0)) await close();
});

function counted(db: Db): { db: Db; calls: () => number } {
  let calls = 0;
  const proxy = new Proxy(db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "run" && key !== "transaction") return value.bind(target);
      return (...args: unknown[]) => {
        calls += 1;
        return value.apply(target, args);
      };
    },
  });
  return { db: proxy, calls: () => calls };
}

async function item(db: Db, id: string, at: number) {
  await insertQueuedItem(db, { id, title: `Task ${id}`, sessionKey: `session-${id}`, now: at });
  await seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ linearIdentifier: id, linearIssueId: `lin-${id}` })
      .where(eq(q.t.workItem.id, id)),
  );
}

async function reviewed(db: Db, id: string, at: number) {
  const { run } = await beginImplementRun(db, id, at + 1);
  const [itemId, questionId, evidenceId] = [id, `q-${id}`, `shot-${id}`];
  const checkId = "visual-proof";
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.evidence).values({
        id: evidenceId,
        itemId,
        runId: run.id,
        checkId,
        attempt: 1,
        sizeBytes: 4,
        headCommit: HEAD,
        mediaType: "image/png",
        sha256: "0".repeat(64),
        displayName: "shot.png",
        createdAt: at + 2,
      }),
    (q) =>
      q.orm
        .insert(q.t.visualReview)
        .values({ itemId, checkId, questionId, evidenceIds: [evidenceId], createdAt: at + 3 }),
    (q) =>
      q.orm
        .insert(q.t.visualReviewMark)
        .values({
          id: `mark-${id}`,
          questionId,
          evidenceId,
          sizeBytes: 4,
          sha256: "1".repeat(64),
          createdAt: at + 4,
        }),
    (q) =>
      q.orm
        .insert(q.t.ciRerun)
        .values({ itemId, headSha: HEAD, runIds: [7], reason: "flaky", at: at + 5 }),
    (q) =>
      q.orm
        .insert(q.t.candidateRisk)
        .values({
          itemId,
          headSha: HEAD,
          baseSha: "b".repeat(40),
          tier: "normal",
          paths: [],
          classifiedAt: at + 6,
        }),
    (q) =>
      q.orm.insert(q.t.riskFix).values({
        itemId,
        headSha: HEAD,
        approvedHead: "c".repeat(40),
        approvedQuestionId: questionId,
        changed: ["README.md"],
        paths: [],
        recordedAt: at + 7,
      }),
  );
  await startUsagePause(db, {
    runId: run.id,
    itemId,
    agent: "claude",
    runnerId: "agentbox",
    resetsAt: at + 60_000,
    resumeAt: at + 60_000,
    pausedAt: at + 8,
  });
}

async function world(extra: number): Promise<Db> {
  setSystemTime(new Date(T0));
  const { db, close } = await tempStore();
  open.push(close);
  await item(db, "PAS-1", T0);
  await reviewed(db, "PAS-1", T0);
  await item(db, "PAS-2", T0 + 1_000);
  await item(db, "PAS-3", T0 + 2_000);
  await beginImplementRun(db, "PAS-3", T0 + 2_001);
  await enterMergeQueue(db, "PAS-3", {
    phase: "merge_queue",
    baseSha: "d".repeat(40),
    wipCommit: "e".repeat(40),
  });
  await applyWorkItemEvent(db, "PAS-3", "merge_accepted", { now: T0 + 3_000 });
  await recordConfirmedRemoteMerge(db, {
    itemId: "PAS-3",
    repositoryOwner: "o",
    repositoryName: "r",
    pullNumber: 3,
    pullUrl: null,
    mergeSha: "f".repeat(40),
    confirmedAt: T0 + 3_000,
  });
  await item(db, "PAS-4", T0 + 4_000);
  await applyWorkItemEvent(db, "PAS-4", "cancel", { now: T0 + 4_500 });
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.taskBlock).values([
        { blockerLinearIssueId: "lin-PAS-1", blockedLinearIssueId: "lin-PAS-2" },
        { blockerLinearIssueId: "lin-PAS-3", blockedLinearIssueId: "lin-PAS-2" },
      ]),
    (q) =>
      q.orm
        .insert(q.t.itemHold)
        .values({ itemId: "PAS-2", reason: "blocked", blockers: ["PAS-1"] }),
    (q) => q.orm.insert(q.t.itemBlockerCheck).values({ itemId: "PAS-2", checkedAt: T0 + 5_000 }),
    (q) =>
      q.orm.insert(q.t.linearConversation).values({ itemId: "PAS-4", entries: "[]", blocked: 1 }),
    (q) =>
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey: "created-PAS-1",
        source: "webhook",
        action: "created",
        sessionId: "session-PAS-1",
        payload: { agentSession: { url: "https://linear.app/kyku/session-1" } },
        updatedAtMs: 1,
        receivedAt: 1,
      }),
  );
  for (let index = 0; index < extra; index += 1) {
    const id = `PAS-${100 + index}`;
    const at = T0 - 10_000 - index * 1_000;
    await item(db, id, at);
    if (index % 2 === 0) await reviewed(db, id, at);
    else await beginImplementRun(db, id, at + 1);
  }
  return db;
}

function stable(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, "<ulid>");
}

async function reads(extra: number) {
  const store = counted(await world(extra));
  const provider = createLiveStatusProvider(store.db, {
    now: () => new Date(T0 + 60_000),
    env: {},
  });
  const issues = stable(await provider.issues());
  const calls = store.calls();
  return { calls, json: [issues, stable(await provider.overview())].map(digest) };
}

const digest = (json: string) => createHash("sha256").update(json).digest("hex");

const BEFORE_BATCHING = [
  [
    "9260d392132f855edfb826f5bdab136834c30ec7327ac7671bed3ab29c06b8df",
    "0b540e9bc4aac8df5fa88dad4a8899acfb7c28ebcf3c38b9fd7af1518845bfff",
  ],
  [
    "9d0ebce13f36e895145c4e23f961a8c32264a939ed72d54b4bf40fc6e403d699",
    "6d3cc225d6266f187614bc6c18cf5b926bf17b369e52ffba10f0f5ecc1902302",
  ],
];

describe("the issue list", () => {
  test("reads the same store calls with 2 or 20 other items and returns its JSON from before batching", async () => {
    const small = await reads(2);
    const large = await reads(20);
    expect(large.calls).toBe(small.calls);
    expect(large.calls).toBeLessThanOrEqual(40);
    expect([small.json, large.json]).toEqual(BEFORE_BATCHING);
  });
});
