import { describe, expect, test } from "bun:test";
import {
  CHECK_LOG_TAIL_BYTES,
  GENERATED_AT_HEADER,
  parseIssueCheckLogResponse,
  parseIssueDetailResponse,
  parseIssueListResponse,
  type IssueDetailResponse,
} from "../contract";
import { emptyIssueList, type CheckLogRequest, type CheckOutput } from "../live/provider";
import { createResourceCache, handleStatusRequest, type StatusProvider } from "./handler";

const NO_SIZES = { record() {}, flush() {} };

function detailOf(id: string, generatedAt = new Date().toISOString()): IssueDetailResponse {
  const list = emptyIssueList();
  return {
    source: "live",
    generatedAt,
    project: list.project,
    issue: {
      id,
      title: id,
      state: "queued",
      agent: "claude",
      assignee: "Paws",
      owner: null,
      project: null,
      blockers: [],
      attempts: 0,
      branch: null,
      runId: null,
      pr: null,
      links: [],
    },
    earlierSessions: [],
    blocks: [],
    risk: null,
    runs: [],
    questions: [],
    verdicts: [],
    agentCloseout: [],
    evidence: [],
    ciRounds: [],
    mergeQueue: [],
    mergeHistory: [],
    dead: [],
  };
}

function recording(outputs: Record<string, CheckOutput> = {}) {
  const calls: string[] = [];
  const logs: CheckLogRequest[] = [];
  const provider: StatusProvider = {
    issues() {
      calls.push("issues");
      return emptyIssueList();
    },
    issue(id) {
      calls.push(`issue:${id}`);
      return id === "PAS-1" ? detailOf(id) : null;
    },
    checkLog(request) {
      calls.push("checkLog");
      logs.push(request);
      return outputs[request.checkId] ?? null;
    },
  };
  return { calls, logs, provider };
}

function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Request(`http://127.0.0.1${path}`, { method, headers });
}

describe("issue resource routes", () => {
  test("the list reads only the list, with generatedAt, a weak ETag, 304 and no-store", async () => {
    const { calls, provider } = recording();
    const first = (await handleStatusRequest(get("/api/issues"), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    const parsed = parseIssueListResponse(await first.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(first.headers.get(GENERATED_AT_HEADER)).toBe(parsed.response.generatedAt);
    const unchanged = (await handleStatusRequest(get("/api/issues", { "If-None-Match": etag }), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("Cache-Control")).toBe("no-store");
    expect(calls).toEqual(["issues", "issues"]);
  });

  test("the detail reads one issue; unknown and invisible issues answer the same 404", async () => {
    const { calls, provider } = recording();
    const found = (await handleStatusRequest(get("/api/issues/PAS-1"), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(found.status).toBe(200);
    const parsed = parseIssueDetailResponse(await found.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.response.issue.id).toBe("PAS-1");
    expect(found.headers.get("ETag")).toMatch(/^W\//);
    const etag = found.headers.get("ETag")!;
    const missing = (await handleStatusRequest(
      get("/api/issues/PAS-2", { "If-None-Match": etag }),
      {
        provider,
      },
    ))!;
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
    expect(calls).toEqual(["issue:PAS-1", "issue:PAS-2"]);
  });

  test("an invalid detail body is a 500, not a partial page", async () => {
    const provider: StatusProvider = {
      issue: () => ({ ...detailOf("PAS-1"), issue: undefined }) as unknown as IssueDetailResponse,
    };
    const response = (await handleStatusRequest(get("/api/issues/PAS-1"), { provider }))!;
    expect(response.status).toBe(500);
  });

  test("OPTIONS answers CORS for each route and writes are refused", async () => {
    const { provider, calls } = recording();
    for (const path of [
      "/api/issues",
      "/api/issues/PAS-1",
      "/api/issues/PAS-1/attempts/1/checks/test/log",
    ]) {
      const options = (await handleStatusRequest(get(path, {}, "OPTIONS"), { provider }))!;
      expect(options.status).toBe(204);
      expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
      expect((await handleStatusRequest(get(path, {}, "POST"), { provider }))!.status).toBe(405);
    }
    expect(calls).toEqual([]);
  });

  test("a check log is the last 64 KiB of each stream, with the run selector and full=1", async () => {
    const stdout = `${"o".repeat(CHECK_LOG_TAIL_BYTES)}tail-out`;
    const stderr = "short";
    const { logs, provider } = recording({ test: { stdout, stderr } });
    const path = "/api/issues/PAS-1/attempts/2/checks/test/log?run=run-9";
    const tailed = (await handleStatusRequest(get(path), { provider, responseSizes: NO_SIZES }))!;
    expect(tailed.status).toBe(200);
    expect(tailed.headers.get("ETag")).toMatch(/^W\//);
    const parsed = parseIssueCheckLogResponse(await tailed.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Buffer.byteLength(parsed.response.stdout)).toBe(CHECK_LOG_TAIL_BYTES);
    expect(parsed.response.stdout.endsWith("tail-out")).toBe(true);
    expect(parsed.response.stderr).toBe("short");
    expect(parsed.response.truncated).toBe(true);
    expect(parsed.response.fullPath).toBe(
      "/api/issues/PAS-1/attempts/2/checks/test/log?run=run-9&full=1",
    );
    const full = (await handleStatusRequest(get(parsed.response.fullPath!), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    const whole = parseIssueCheckLogResponse(await full.json());
    if (!whole.ok) throw new Error(whole.error);
    expect(whole.response.stdout).toBe(stdout);
    expect(whole.response.truncated).toBe(false);
    expect(logs).toEqual([
      { itemId: "PAS-1", attempt: 2, checkId: "test", run: "run-9" },
      { itemId: "PAS-1", attempt: 2, checkId: "test", run: "run-9" },
    ]);
    const unknown = (await handleStatusRequest(
      get("/api/issues/PAS-1/attempts/2/checks/lint/log"),
      { provider },
    ))!;
    expect(unknown.status).toBe(404);
    const malformed = (await handleStatusRequest(
      get("/api/issues/PAS-1/attempts/0/checks/test/log"),
      {
        provider,
      },
    ))!;
    expect(malformed.status).toBe(404);
  });

  test("reuse is keyed by resource, parameters and reader", async () => {
    let now = 1_700_000_000_000;
    const { calls, provider } = recording();
    const resourceCache = createResourceCache({ now: () => now });
    const read = (path: string, sessionIds?: string[]) =>
      handleStatusRequest(get(path), {
        provider,
        resourceCache,
        responseSizes: NO_SIZES,
        ...(sessionIds === undefined ? {} : { sessionIds }),
      });
    await read("/api/issues", ["a"]);
    await read("/api/issues", ["a"]);
    await read("/api/issues/PAS-1", ["a"]);
    await read("/api/issues/PAS-1", ["a"]);
    await read("/api/issues/PAS-2", ["a"]);
    await read("/api/issues", ["b"]);
    await read("/api/issues/PAS-1", ["b"]);
    await read("/api/issues/PAS-1");
    expect(calls).toEqual([
      "issues",
      "issue:PAS-1",
      "issue:PAS-2",
      "issues",
      "issue:PAS-1",
      "issue:PAS-1",
    ]);
    now += 1_000;
    await read("/api/issues", ["a"]);
    expect(calls.at(-1)).toBe("issues");
    expect(calls).toHaveLength(7);
  });
});
