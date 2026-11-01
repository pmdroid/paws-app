import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../core";
import {
  JobLoop,
  OutboxDispatcher,
  beginMergeCall,
  bindWorkItemRepository,
  getWorkItem,
  insertQueuedItem,
  mergeCallInFlight,
  migrate,
  openDatabase,
  recordItemPullRequest,
} from "../db";
import type { GitHubResponse } from "../github";
import { Orchestrator } from "./orchestrator";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paws-merge-outcome-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  let response: () => Promise<GitHubResponse> = async () => ({ status: 502, body: {} });
  const orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      tokenProvider: { mode: "token", tokenFor: async () => "fake-token" },
      client: { request: () => response() },
    }),
  });
  insertQueuedItem(db, { id: "item", now: clock.now() });
  bindWorkItemRepository(db, "item", { owner: "acme", repo: "app", remoteUrl: "unused" });
  return {
    db,
    read: () => orchestrator["mergedOutsideLane"](getWorkItem(db, "item")!),
    respond: (next: typeof response) => {
      response = next;
    },
    cleanup: async () => {
      await orchestrator.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a missing pull record with a durable marker reports an error instead of parking forever", async () => {
  const f = await fixture();
  try {
    expect(await f.read()).toBeNull();
    beginMergeCall(f.db, "item", "h", 1_000);
    await expect(f.read()).rejects.toThrow("pull request record is missing");
    expect(mergeCallInFlight(f.db, "item")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test.each([404, 403, 502, "timeout"])(
  "%s pull reads cannot clear durable merge-call evidence",
  async (failure) => {
    const f = await fixture();
    try {
      recordItemPullRequest(f.db, {
        itemId: "item",
        pullNumber: 7,
        pullUrl: null,
        openedAt: 1_000,
      });
      beginMergeCall(f.db, "item", "h", 1_000);
      f.respond(async () => {
        if (failure === "timeout") throw new DOMException("Read timed out", "TimeoutError");
        return { status: failure as number, body: {} };
      });
      expect(await f.read()).toBe("unknown");
      expect(mergeCallInFlight(f.db, "item")).toBe(true);
      f.respond(async () => ({ status: 200, body: { merged: false } }));
      expect(await f.read()).toBeNull();
      expect(mergeCallInFlight(f.db, "item")).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);
