import { describe, expect, test } from "bun:test";
import { demoStatus } from "./demo";
import { parseStatusSnapshot, statusIntegrity } from "./contract";
import { statusEndpoint } from "./endpoint";
import { resolveEngineUrl } from "./source";

describe("status contract", () => {
  test("demo snapshot matches the contract and its own references", () => {
    const snapshot = demoStatus();
    const parsed = parseStatusSnapshot(snapshot);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.source).toBe("demo");
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(parsed.snapshot.questions.length).toBeGreaterThan(0);
    expect(parsed.snapshot.verdicts.length).toBeGreaterThan(0);
    expect(parsed.snapshot.mergeQueue.length).toBeGreaterThan(0);
  });

  test("rejects a body that is missing the version", () => {
    const parsed = parseStatusSnapshot({ source: "live" });
    expect(parsed.ok).toBe(false);
  });

  test("rejects a recommended option outside the list", () => {
    const snapshot = demoStatus();
    snapshot.questions[0]!.recommendedOption = 9;
    const parsed = parseStatusSnapshot(snapshot);
    expect(parsed.ok).toBe(false);
  });
});

describe("engine URL", () => {
  test("points at /api/status on the origin", () => {
    expect(statusEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/api/status");
    expect(statusEndpoint("https://tunnel.example/status/")).toBe(
      "https://tunnel.example/api/status",
    );
    expect(statusEndpoint("https://tunnel.example/api/status?x=1")).toBe(
      "https://tunnel.example/api/status",
    );
  });

  test("refuses non-http URLs", () => {
    expect(() => statusEndpoint("javascript:alert(1)")).toThrow();
  });

  test("static site defaults to demo and /status defaults to that origin", () => {
    expect(
      resolveEngineUrl({
        choice: { kind: "auto" },
        baked: null,
        pathname: "/",
        origin: "https://status.example",
      }),
    ).toBeNull();
    expect(
      resolveEngineUrl({
        choice: { kind: "auto" },
        baked: null,
        pathname: "/status/",
        origin: "http://127.0.0.1:8787",
      }),
    ).toBe("http://127.0.0.1:8787/");
    expect(
      resolveEngineUrl({
        choice: { kind: "demo" },
        baked: "http://127.0.0.1:8787",
        pathname: "/status/",
        origin: "http://127.0.0.1:8787",
      }),
    ).toBeNull();
    expect(
      resolveEngineUrl({
        choice: { kind: "engine", url: "https://tunnel.example" },
        baked: null,
        pathname: "/",
        origin: "https://status.example",
      }),
    ).toBe("https://tunnel.example");
  });
});
