import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfigToml } from "../src/config";
import {
  enqueueOutbox,
  listOutbox,
  readSessionDone,
  recordItemPullRequest,
  saveSessionDone,
  type Db,
  type SessionDoneSettings,
} from "../src/db";
import type { PullCi } from "../src/github";
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

function finish(db: Db, ci: PullCi["state"], now: number) {
  const reads: string[] = [];
  return finishOpenedSessions(db, {
    now: () => now,
    readPullCi: async (_, pull) => {
      reads.push(pull.head);
      return { state: ci, message: "" } as PullCi;
    },
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
    const db = await opened({ sessionDone: "settled", sessionQuietMinutes: 10 });
    const now = OPENED + 30 * MINUTE;
    await comment(db, now - 2 * MINUTE);
    await finish(db, "green", now);
    expect(await responses(db)).toEqual([]);
    await finish(db, "green", now + 8 * MINUTE);
    expect(await responses(db)).toEqual([`${BODY}\n\nCI is green and review rounds are done.`]);
  });

  test("settled waits while a fix round runs", async () => {
    const db = await opened({ sessionDone: "settled" }, "running");
    await finish(db, "green", OPENED + 60 * MINUTE);
    expect(await responses(db)).toEqual([]);
  });

  test("a merged pull request keeps its merged response and gets no ready one", async () => {
    const db = await opened({ sessionDone: "ci_green" });
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.workItem).set({ state: "merged" }));
    });
    expect(await finish(db, "green", OPENED + 5 * 60 * MINUTE)).toEqual([]);
    expect(await responses(db)).toEqual([]);
  });

  test("after 4 hours the ready response names what it still waits for", async () => {
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

  test("pull_request leaves an opened thought alone", async () => {
    const db = await opened({ sessionDone: "pull_request" });
    expect(await finish(db, "green", OPENED + 5 * 60 * MINUTE)).toEqual([]);
    expect(await responses(db)).toEqual([]);
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
    const read = async () =>
      (await (await handleMergeSettingsRequest(request(), options))!.json()) as Record<
        string,
        unknown
      >;
    expect(await read()).toMatchObject({ sessionDone: "pull_request", sessionQuietMinutes: 10 });
    const put = (body: object) =>
      handleMergeSettingsRequest(
        request("PUT", { default: { order: "queue", mainMoved: "ci" }, ...body }),
        options,
      );
    const saved = await put({ sessionDone: "settled", sessionQuietMinutes: 25 });
    expect(saved?.status).toBe(200);
    expect(await saved!.json()).toMatchObject({ sessionDone: "settled", sessionQuietMinutes: 25 });
    expect(await readSessionDone(store.db)).toEqual({
      sessionDone: "settled",
      sessionQuietMinutes: 25,
    });
    for (const body of [
      { sessionDone: "merged" },
      { sessionQuietMinutes: 0 },
      { sessionQuietMinutes: 121 },
      { sessionQuietMinutes: 2.5 },
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
