import { describe, expect, test } from "bun:test";
import { GENERATED_AT_HEADER, parseMergeQueueResponse, type MergeQueueResponse } from "../contract";
import { emptyMergeQueue } from "../live/provider";
import { createStatusSnapshotCache, handleStatusRequest, type StatusProvider } from "./handler";

const NO_SIZES = { record() {}, flush() {} };

function queueWith(itemId: string): MergeQueueResponse {
  return {
    ...emptyMergeQueue(),
    entries: [
      {
        position: 1,
        itemId,
        repository: "acme/platform",
        enqueuedAt: "2026-11-02T10:00:00.000Z",
        acceptedAt: "2026-11-02T10:00:00.000Z",
        waitingFor: "ci",
        detail: null,
        settings: { order: "queue", mainMoved: "ci", rule: null },
        steps: [],
      },
    ],
    issues: [{ id: itemId, title: itemId, owner: null, project: null, pr: null }],
  };
}

function recording(read: () => MergeQueueResponse = () => queueWith("ENG-1")) {
  const calls: string[] = [];
  const provider: StatusProvider = {
    snapshot() {
      calls.push("snapshot");
      throw new Error("the snapshot is not the merge queue");
    },
    item(id) {
      calls.push(`item:${id}`);
      return null;
    },
    issues() {
      calls.push("issues");
      throw new Error("the issue list is not the merge queue");
    },
    checkLog() {
      calls.push("checkLog");
      return null;
    },
    mergeQueue() {
      calls.push("mergeQueue");
      return read();
    },
  };
  return { calls, provider };
}

function get(headers: Record<string, string> = {}, method = "GET") {
  return new Request("http://127.0.0.1/api/merge-queue", { method, headers });
}

describe("merge queue resource route", () => {
  test("reads only the merge queue, with generatedAt, a weak ETag, 304 and no-store", async () => {
    const { calls, provider } = recording();
    const first = (await handleStatusRequest(get(), { provider, responseSizes: NO_SIZES }))!;
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    const parsed = parseMergeQueueResponse(await first.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.response.entries.map((entry) => entry.itemId)).toEqual(["ENG-1"]);
    expect(first.headers.get(GENERATED_AT_HEADER)).toBe(parsed.response.generatedAt);
    const unchanged = (await handleStatusRequest(get({ "If-None-Match": etag }), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(calls).toEqual(["mergeQueue", "mergeQueue"]);
  });

  test("a built queue is reused per reader session set, never across readers", async () => {
    const { calls, provider } = recording();
    const snapshotCache = createStatusSnapshotCache({ now: () => 0 });
    const read = (sessionIds: readonly string[]) =>
      handleStatusRequest(get(), { provider, sessionIds, snapshotCache, responseSizes: NO_SIZES });
    await read(["a", "b"]);
    await read(["b", "a"]);
    expect(calls).toEqual(["mergeQueue"]);
    await read(["c"]);
    expect(calls).toEqual(["mergeQueue", "mergeQueue"]);
  });

  test("an invalid body is a 500, and only GET and HEAD are served", async () => {
    const broken = recording(() => ({ ...emptyMergeQueue(), issues: undefined }) as never);
    const invalid = (await handleStatusRequest(get(), {
      provider: broken.provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(invalid.status).toBe(500);
    const { provider } = recording();
    expect((await handleStatusRequest(get({}, "POST"), { provider }))!.status).toBe(405);
    expect((await handleStatusRequest(get({}, "HEAD"), { provider }))!.status).toBe(200);
  });
});
