import { describe, expect, test } from "bun:test";
import { GENERATED_AT_HEADER, type StatusSnapshot } from "../contract";
import { statusFixture } from "../../test/fixtures";
import { livePoll } from "./poll";
import { createStatusReader, STATUS_POLL_MS } from "./status-reader";

function fakes() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  let handler: (() => void) | null = null;
  let every = 0;
  const timers = {
    setInterval: (next: () => void, ms: number) => {
      handler = next;
      every = ms;
      return 1;
    },
    clearInterval: () => {
      handler = null;
    },
  };
  return {
    doc,
    timers,
    listeners,
    fire: () => handler?.(),
    show: (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      for (const listener of listeners) listener();
    },
    every: () => every,
    running: () => handler !== null,
  };
}

describe("live polling", () => {
  test("refreshes on an interval only while the page is visible", () => {
    const fake = fakes();
    let ticks = 0;
    const stop = livePoll(() => ticks++, 10_000, fake.doc as never, fake.timers as never);
    expect(fake.every()).toBe(10_000);
    fake.fire();
    expect(ticks).toBe(1);
    fake.show("hidden");
    fake.fire();
    expect(ticks).toBe(1);
    fake.show("visible");
    expect(ticks).toBe(2);
    stop();
    expect(fake.running()).toBe(false);
    expect(fake.listeners.size).toBe(0);
  });

  test("a hidden dashboard tab requests no status, and one when it is shown again", async () => {
    const fake = fakes();
    const requests: string[] = [];
    const read = createStatusReader(async (path) => {
      requests.push(path);
      return Response.json(statusFixture(), { headers: { ETag: 'W/"a"' } });
    });
    const stop = livePoll(
      () => void read(["items", "questions"]),
      STATUS_POLL_MS,
      fake.doc as never,
      fake.timers as never,
    );
    expect(fake.every()).toBe(5000);
    fake.fire();
    expect(requests).toHaveLength(1);

    fake.show("hidden");
    for (let tick = 0; tick < 12; tick++) fake.fire();
    expect(requests).toHaveLength(1);

    fake.show("visible");
    expect(requests).toEqual([
      "/api/status?slices=items,questions",
      "/api/status?slices=items,questions",
    ]);
    stop();
  });
});

describe("status reader", () => {
  test("asks with the last ETag of the same slices and keeps the list on a 304", async () => {
    const sent: { path: string; match: string | null }[] = [];
    let unchanged = false;
    const read = createStatusReader(async (path, init) => {
      const match = new Headers(init.headers).get("If-None-Match");
      sent.push({ path, match });
      if (unchanged && match === 'W/"v1"')
        return new Response(null, {
          status: 304,
          headers: { ETag: 'W/"v1"', [GENERATED_AT_HEADER]: "2026-10-27T10:00:05.000Z" },
        });
      return Response.json(
        { ...statusFixture(), slices: ["items"] },
        { headers: { ETag: 'W/"v1"' } },
      );
    });

    const first = await read(["items"]);
    unchanged = true;
    const second = await read(["items"]);
    const other = await read(["evidence"]);

    expect(sent).toEqual([
      { path: "/api/status?slices=items", match: null },
      { path: "/api/status?slices=items", match: 'W/"v1"' },
      { path: "/api/status?slices=evidence", match: null },
    ]);
    if (first.kind !== "loaded" || second.kind !== "loaded" || other.kind !== "loaded")
      throw new Error("expected loaded lists");
    const { generatedAt: _first, ...before } = first.snapshot;
    const { generatedAt, ...after } = second.snapshot as StatusSnapshot;
    expect(after).toEqual(before);
    expect(generatedAt).toBe("2026-10-27T10:00:05.000Z");
  });

  test("hands any other response back to the page", async () => {
    const read = createStatusReader(async () => Response.json({ error: "no" }, { status: 401 }));
    const result = await read(["items"]);
    expect(result.kind).toBe("response");
  });
});
