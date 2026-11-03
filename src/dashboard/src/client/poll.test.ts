import { describe, expect, test } from "bun:test";
import { OVERVIEW_API_PATH, parseOverviewResponse } from "../contract";
import { emptyOverview } from "../live/overview";
import { livePoll, PAGE_POLL_MS } from "./poll";
import { createResourceReader } from "./resource-reader";

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

  test("a hidden dashboard tab requests nothing, and its resource once when it is shown again", async () => {
    const fake = fakes();
    const requests: string[] = [];
    const resources = createResourceReader(async (path) => {
      requests.push(path);
      return Response.json(emptyOverview(), { headers: { ETag: 'W/"a"' } });
    });
    const parse = (input: unknown) => {
      const parsed = parseOverviewResponse(input);
      return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
    };
    const stop = livePoll(
      () => void resources.read(OVERVIEW_API_PATH, "", parse),
      PAGE_POLL_MS,
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
    expect(requests).toEqual([OVERVIEW_API_PATH, OVERVIEW_API_PATH]);
    stop();
  });
});
