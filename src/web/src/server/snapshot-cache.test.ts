import { describe, expect, test } from "bun:test";
import {
  createStatusSnapshotCache,
  handleStatusRequest,
  STATUS_SNAPSHOT_REUSE_MS,
} from "./handler";
import { emptyLiveSnapshot } from "../live/provider";

function poll(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/status", { headers });
}

describe("status snapshot cache", () => {
  test("two polls within a second build the payload once, and a matching ETag gets 304", async () => {
    let now = 1_700_000_000_000;
    let builds = 0;
    const provider = {
      snapshot() {
        builds += 1;
        return emptyLiveSnapshot();
      },
    };
    const snapshotCache = createStatusSnapshotCache({ now: () => now });
    const first = (await handleStatusRequest(poll(), { provider, snapshotCache }))!;
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^"[0-9a-z]+"$/);
    const body = await first.text();
    now += STATUS_SNAPSHOT_REUSE_MS - 1;
    const second = (await handleStatusRequest(poll(), { provider, snapshotCache }))!;
    expect(await second.text()).toBe(body);
    expect(builds).toBe(1);
    const unchanged = (await handleStatusRequest(poll({ "If-None-Match": etag }), {
      provider,
      snapshotCache,
    }))!;
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("ETag")).toBe(etag);
    expect(builds).toBe(1);
    now += 1;
    const stale = (await handleStatusRequest(poll({ "If-None-Match": '"other"' }), {
      provider,
      snapshotCache,
    }))!;
    expect(stale.status).toBe(200);
    expect(builds).toBe(2);
  });

  test("polls that arrive while the payload builds wait for that build", async () => {
    let builds = 0;
    const ready = Promise.withResolvers<void>();
    const provider = {
      async snapshot() {
        builds += 1;
        await ready.promise;
        return emptyLiveSnapshot();
      },
    };
    const snapshotCache = createStatusSnapshotCache();
    const polls = [1, 2, 3].map(() => handleStatusRequest(poll(), { provider, snapshotCache }));
    ready.resolve();
    expect((await Promise.all(polls)).map((response) => response!.status)).toEqual([200, 200, 200]);
    expect(builds).toBe(1);
  });

  test("each reader gets its own payload, and a failed build is not reused", async () => {
    let builds = 0;
    let fail = true;
    const provider = {
      snapshot() {
        builds += 1;
        if (fail) throw new Error("database is locked");
        return emptyLiveSnapshot();
      },
    };
    const snapshotCache = createStatusSnapshotCache();
    const failed = await handleStatusRequest(poll(), { provider, snapshotCache });
    expect(failed!.status).toBe(500);
    fail = false;
    await handleStatusRequest(poll(), { provider, snapshotCache, sessionIds: ["a"] });
    await handleStatusRequest(poll(), { provider, snapshotCache, sessionIds: ["b"] });
    await handleStatusRequest(poll(), { provider, snapshotCache, sessionIds: ["a"] });
    expect(builds).toBe(3);
  });

  test("without a cache every poll builds the payload", async () => {
    let builds = 0;
    const provider = {
      snapshot() {
        builds += 1;
        return emptyLiveSnapshot();
      },
    };
    await handleStatusRequest(poll(), { provider });
    await handleStatusRequest(poll(), { provider });
    expect(builds).toBe(2);
  });
});
