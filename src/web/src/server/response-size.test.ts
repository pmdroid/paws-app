import { describe, expect, test } from "bun:test";
import { handleStatusRequest } from "./handler";
import { emptyLiveSnapshot } from "../live/provider";
import { createResponseSizeJournal, RESPONSE_SIZE_WINDOW_MS } from "./response-size";

describe("status response size journal", () => {
  test("journals one line per minute with the largest response served in it", () => {
    const lines: string[] = [];
    let now = 1_700_000_040_000;
    const sizes = createResponseSizeJournal({
      now: () => now,
      write: (line) => lines.push(line),
      timer: false,
    });
    sizes.record("/api/status", 120);
    sizes.record("/api/status/items/PAS-1", 900);
    sizes.record("/api/status", 300);
    expect(lines).toEqual([]);
    now += RESPONSE_SIZE_WINDOW_MS;
    sizes.record("/api/status", 50);
    expect(lines).toEqual([
      "status payload minute=2023-11-14T22:14:00.000Z largest_bytes=900 path=/api/status/items/PAS-1 responses=3",
    ]);
    sizes.flush();
    sizes.flush();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "status payload minute=2023-11-14T22:15:00.000Z largest_bytes=50 path=/api/status responses=1",
    );
  });

  test("the minute's line is written when it ends without another request", async () => {
    const lines: string[] = [];
    let now = 1_700_000_040_000 + RESPONSE_SIZE_WINDOW_MS - 5;
    const sizes = createResponseSizeJournal({ now: () => now, write: (line) => lines.push(line) });
    sizes.record("/api/status", 10);
    await Bun.sleep(30);
    expect(lines).toHaveLength(1);
    now += 30;
    sizes.flush();
    expect(lines).toHaveLength(1);
  });

  test("the handler records the bytes of each status body it serves", async () => {
    const recorded: [string, number][] = [];
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      provider: { snapshot: () => emptyLiveSnapshot() },
      responseSizes: { record: (path, bytes) => recorded.push([path, bytes]), flush() {} },
    });
    const body = await response!.text();
    expect(recorded).toEqual([["/api/status", Buffer.byteLength(body)]]);
    await handleStatusRequest(new Request("http://127.0.0.1/api/status/items/PAS-404"), {
      provider: { snapshot: () => emptyLiveSnapshot(), item: () => null },
      responseSizes: { record: (path, bytes) => recorded.push([path, bytes]), flush() {} },
    });
    // A 404 is not a payload.
    expect(recorded).toHaveLength(1);
  });
});
