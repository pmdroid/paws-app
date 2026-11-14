import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfigToml } from "../src/config";
import {
  enqueueOutbox,
  listOutbox,
  readSessionDone,
  recordCarriedAccept,
  recordItemPullRequest,
  saveSessionDone,
  type Db,
  type SessionDoneSettings,
} from "../src/db";
import type { PullCi } from "../src/github";
import { createFakeTracker } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { finishOpenedSessions } from "../src/loop/session-done";
import { handleMergeSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const OPENED = 1_000_000;
const MINUTE = 60_000;
const BODY = "Opened https://github.com/acme/app/pull/7.";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function opened(settings: Partial<SessionDoneSettings>, state = "merge_queue") {
  const store = await tempStore();
  close = store.close;
  const db = store.db;
  await saveSessionDone(db, { sessionDone: "ci_green", sessionQuietMinutes: 10, ...settings });
  await db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.workItem).values({
        id: "item",
        delegationId: "item",
        linearIssueId: "issue-item",
        linearIdentifier: "ACME-7",
        title: "item",
        state,
        branchName: "paws/item",
        position: 0,
        createdAt: 0,
        sessionKey: "session",
        acceptedHead: "head-1",
      }),
    );
  });
  await recordItemPullRequest(db, {
    itemId: "item",
    pullNumber: 7,
    pullUrl: null,
    openedAt: OPENED,
  });
  await enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    delivery: "ordered",
    idempotencyKey: "pull-request-opened:item:0",
    payload: { sessionId: "session", itemId: "item", kind: "thought", body: BODY },
    now: OPENED,
  });
  return db;
}

function finish(
  db: Db,
  ci: PullCi["state"],
  now: number,
  options: { checks?: string[]; open?: boolean | null; head?: string } = {},
) {
  const reads: string[] = [];
  return finishOpenedSessions(db, {
    now: () => now,
    readPullCi: async (_, pull) => {
      reads.push(pull.head);
      const checks = (options.checks ?? ["SUCCESS"]).map((conclusion, index) => ({
        name: `check-${index}`,
        conclusion,
        url: null,
      }));
      return { state: ci, message: "", checks, failedChecks: [] } as PullCi;
    },
    readPull: async () =>
      options.open === null ? null : { head: options.head ?? "head-1", open: options.open ?? true },
  }).then(() => reads);
}

async function responses(db: Db) {
  return (await listOutbox(db, "session"))
    .filter((row) => row.idempotencyKey.startsWith("pull-request-ready:"))
    .map((row) => (row.payload as { kind: string; body: string }).body);
}

async function comment(db: Db, receivedAt: number) {
  await db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.pullComment).values({
        source: "conversation",
        commentId: receivedAt,
        itemId: "item",
        pullNumber: 7,
        body: "Bugbot found something",
        receivedAt,
      }),
    );
  });
}

describe("when Paws finishes the Linear session", () => {
  test("ci_green posts the ready response once the accepted head is green, not before", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    expect(await finish(db, "pending", OPENED + MINUTE)).toEqual(["head-1"]);
    expect(await responses(db)).toEqual([]);
    await finish(db, "green", OPENED + 2 * MINUTE);
    expect(await responses(db)).toEqual([`${BODY}\n\nCI is green.`]);
    expect(await finish(db, "green", OPENED + 3 * MINUTE)).toEqual([]);
  });

  test("settled waits for the quiet minutes after the last comment", async () => {
    const db = await opened({ sessionDone: "settled" });
    const now = OPENED + 30 * MINUTE;
    await comment(db, now - 2 * MINUTE);
    await finish(db, "green", now);
    expect(await responses(db)).toEqual([]);
    await finish(db, "green", now + 8 * MINUTE);
    expect(await responses(db)).toEqual([`${BODY}\n\nCI is green and review rounds are done.`]);
  });

  test("a merged pull request keeps its merged response and gets no ready one", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.workItem).set({ state: "merged" }));
    });
    expect(await finish(db, "green", OPENED + 5 * 60 * MINUTE)).toEqual([]);
    expect(await responses(db)).toEqual([]);
  });

  test("settled waits through a fix round; after 4 hours it says what it waits for", async () => {
    for (const [ci, line] of [
      ["pending", "CI pending"],
      ["failed", "CI failing"],
      ["green", "recent review activity"],
    ] as const) {
      const db = await opened({ sessionDone: "settled" }, "running");
      await finish(db, ci, OPENED + 4 * 60 * MINUTE - 1);
      expect(await responses(db)).toEqual([]);
      await finish(db, ci, OPENED + 4 * 60 * MINUTE);
      expect(await responses(db)).toEqual([`${BODY}\n\nStill waiting: ${line}.`]);
      await close?.();
      close = undefined;
    }
  });

  test("an approval or review webhook restarts the quiet minutes", async () => {
    const db = await opened({ sessionDone: "settled" });
    const now = OPENED + 30 * MINUTE;
    await db.run(function* (q) {
      yield* q.exec(
        q.orm.insert(q.t.workItemRepository).values({
          itemId: "item",
          owner: "acme",
          repo: "app",
          remoteUrl: "https://github.com/acme/app.git",
        }),
      );
      yield* q.exec(
        q.orm.insert(q.t.githubDelivery).values({
          deliveryId: "approval",
          event: "pull_request_review",
          payload: JSON.stringify({
            action: "submitted",
            repository: { full_name: "Acme/App" },
            pull_request: { number: 7 },
            review: { state: "approved" },
          }),
          receivedAt: now - MINUTE,
        }),
      );
      yield* q.exec(
        q.orm.insert(q.t.pullReview).values({
          itemId: "item",
          state: "changes_requested",
          pullNumber: 7,
          body: "Please rename it",
          receivedAt: now - 3 * MINUTE,
        }),
      );
    });
    await finish(db, "green", now);
    expect(await responses(db)).toEqual([]);
    await finish(db, "green", now + 8.5 * MINUTE);
    expect(await responses(db)).toEqual([]);
    await finish(db, "green", now + 9 * MINUTE);
    expect(await responses(db)).toHaveLength(1);
  });

  test("unknown CI posts nothing on a pull request closed on GitHub, and waits out the cap otherwise", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await finish(db, "unknown", OPENED + 5 * 60 * MINUTE, { open: false });
    expect(await responses(db)).toEqual([]);
    await finish(db, "unknown", OPENED + MINUTE, { open: null });
    expect(await responses(db)).toEqual([]);
    await finish(db, "unknown", OPENED + 5 * 60 * MINUTE, { open: null });
    expect(await responses(db)).toEqual([`${BODY}\n\nStill waiting: CI pending.`]);
  });

  test("the cap counts from the pull request's first opening, not a later publication", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.outbox).set({ createdAt: OPENED + 3 * 60 * MINUTE }));
    });
    await finish(db, "pending", OPENED + 4 * 60 * MINUTE);
    expect(await responses(db)).toEqual([`${BODY}\n\nStill waiting: CI pending.`]);
  });

  test("a closed pull request gets nothing even when no head is accepted", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.workItem).set({ acceptedHead: null }));
    });
    expect(await finish(db, "pending", OPENED + 5 * 60 * MINUTE, { open: false })).toEqual([]);
    expect(await responses(db)).toEqual([]);
  });

  test("a head the merge lane rebased with carried acceptance is the one CI is read on", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await recordCarriedAccept(db, {
      itemId: "item",
      head: "head-2",
      acceptedHead: "head-1",
      base: "main-2",
      now: OPENED,
    });
    expect(await finish(db, "green", OPENED + MINUTE, { head: "head-2" })).toEqual(["head-2"]);
    expect(await responses(db)).toEqual([`${BODY}\n\nCI is green.`]);
  });

  test("a pull request head without Closeout acceptance never counts as green", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.workItem).set({ acceptedHead: null }));
    });
    expect(await finish(db, "green", OPENED + MINUTE, { head: "head-2" })).toEqual([]);
    expect(await responses(db)).toEqual([]);
  });

  test("an optional check that is failing or running keeps green CI from finishing the session", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await finish(db, "green", OPENED + MINUTE, { checks: ["SUCCESS", "IN_PROGRESS"] });
    await finish(db, "green", OPENED + 2 * MINUTE, { checks: ["SUCCESS", "FAILURE"] });
    expect(await responses(db)).toEqual([]);
    await finish(db, "green", OPENED + 4 * 60 * MINUTE, { checks: ["SUCCESS", "FAILURE"] });
    expect(await responses(db)).toEqual([`${BODY}\n\nStill waiting: CI failing.`]);
  });

  test("an item that moved on while CI was read gets no response from that read", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await finishOpenedSessions(db, {
      now: () => OPENED + MINUTE,
      readPullCi: async () => {
        await db.run(function* (q) {
          yield* q.exec(
            q.orm.update(q.t.workItem).set({ state: "running", version: sql`version + 1` }),
          );
        });
        return { state: "green", checks: [] } as PullCi;
      },
      readPull: async () => ({ head: "head-1", open: true }),
    });
    expect(await responses(db)).toEqual([]);
  });

  test("a response notice while the session waits is delivered as a thought", async () => {
    const db = await opened({ sessionDone: "settled" });
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      delivery: "ordered",
      idempotencyKey: "merge-review:item:0:required:head-1",
      payload: { sessionId: "session", itemId: "item", kind: "response", body: "Needs approval." },
    });
    const tracker = createFakeTracker();
    const row = (await listOutbox(db, "session")).find((stored) =>
      stored.idempotencyKey.startsWith("merge-review:"),
    )!;
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      delivery: "ordered",
      idempotencyKey: "merged:item:0",
      payload: { sessionId: "session", itemId: "item", kind: "response", body: "Merged." },
    });
    await deliverLinearOutbox(row, tracker, async () => {}, undefined, db);
    expect(tracker.progress.map((update) => update.kind)).toEqual(["thought"]);
  });

  test("switching to pull_request finishes a session that was waiting", async () => {
    const db = await opened({ sessionDone: "pull_request" });
    expect(await finish(db, "pending", OPENED + MINUTE)).toEqual([]);
    expect(await responses(db)).toEqual([BODY]);
  });
});

describe("the session setting on the Merging settings API", () => {
  const request = (method = "GET", body?: unknown) =>
    new Request("http://127.0.0.1:8787/api/settings/merging", {
      method,
      headers: { "Content-Type": "application/json", "x-paws-csrf": "test-token" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("GET and PUT read and save it in the database; invalid values are refused", async () => {
    const store = await tempStore();
    close = store.close;
    const configPath = join(tempHome(), "config.toml");
    const options = { configPath, csrfToken: "test-token", store: store.db };
    const read = async () => (await handleMergeSettingsRequest(request(), options))!.json();
    expect(await read()).toMatchObject({ sessionDone: "pull_request", sessionQuietMinutes: 10 });
    const put = (body: object) =>
      handleMergeSettingsRequest(
        request("PUT", { default: { order: "queue", mainMoved: "ci" }, ...body }),
        options,
      );
    const saved = await put({ sessionDone: "settled", sessionQuietMinutes: 25 });
    expect(saved?.status).toBe(200);
    expect(await saved!.json()).toMatchObject({ sessionDone: "settled", sessionQuietMinutes: 25 });
    expect(await readSessionDone(store.db)).toMatchObject({ sessionQuietMinutes: 25 });
    for (const body of [
      { sessionDone: "merged" },
      { sessionDone: null },
      ...[0, 121, 2.5, null].map((n) => ({ sessionQuietMinutes: n })),
    ])
      expect((await put(body))?.status).toBe(400);
    expect((await put({}))?.status).toBe(200);
    expect(await read()).toMatchObject({ sessionDone: "settled", sessionQuietMinutes: 25 });
  });

  test("config.toml has no [linear] session key", () => {
    for (const key of ['session_done = "settled"', "session_quiet_minutes = 5"])
      expect(() => parseConfigToml(`[linear]\n${key}\n`)).toThrow("unknown key");
  });
});
