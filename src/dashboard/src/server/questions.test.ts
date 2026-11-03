import { describe, expect, test } from "bun:test";
import {
  GENERATED_AT_HEADER,
  parseQuestionDetailResponse,
  parseQuestionListResponse,
  type QuestionDetailResponse,
} from "../contract";
import { questionCardFixture } from "../../test/fixtures";
import { createResourceCache, handleStatusRequest, type StatusProvider } from "./handler";

const NO_SIZES = { record() {}, flush() {} };

const card = questionCardFixture;

function recording(generatedAt = () => new Date().toISOString()) {
  const calls: string[] = [];
  const provider: StatusProvider = {
    issues() {
      calls.push("issues");
      throw new Error("the issue list is not a question resource");
    },
    questions() {
      calls.push("questions");
      return { source: "live", generatedAt: generatedAt(), questions: [card("q-1")] };
    },
    question(id) {
      calls.push(`question:${id}`);
      return id === "q-1"
        ? { source: "live", generatedAt: generatedAt(), question: card(id) }
        : null;
    },
  };
  return { calls, provider };
}

function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Request(`http://127.0.0.1${path}`, { method, headers });
}

describe("question resource routes", () => {
  test("the list reads only questions, with generatedAt, a weak ETag, 304 and no-store", async () => {
    let at = "2026-11-02T09:00:00.000Z";
    const { calls, provider } = recording(() => at);
    const first = (await handleStatusRequest(get("/api/questions"), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    const parsed = parseQuestionListResponse(await first.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.response.questions[0]?.issue).toEqual({
      id: "PAS-1",
      title: "Ship it",
      agent: "claude",
    });
    expect(first.headers.get(GENERATED_AT_HEADER)).toBe(at);
    at = "2026-11-02T09:00:05.000Z";
    const unchanged = (await handleStatusRequest(get("/api/questions", { "If-None-Match": etag }), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get(GENERATED_AT_HEADER)).toBe(at);
    expect(calls).toEqual(["questions", "questions"]);
  });

  test("the detail reads one question; unknown and invisible questions answer the same 404", async () => {
    const { calls, provider } = recording();
    const found = (await handleStatusRequest(get("/api/questions/q-1"), {
      provider,
      responseSizes: NO_SIZES,
    }))!;
    expect(found.status).toBe(200);
    expect(found.headers.get("Cache-Control")).toBe("no-store");
    const parsed = parseQuestionDetailResponse(await found.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.response.question.id).toBe("q-1");
    const etag = found.headers.get("ETag")!;
    const missing = (await handleStatusRequest(
      get("/api/questions/q-2", { "If-None-Match": etag }),
      { provider },
    ))!;
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(await missing.json()).toEqual({ error: "Not found" });
    for (const path of ["/api/questions/q-1/extra", "/api/questions/%2F"])
      expect((await handleStatusRequest(get(path), { provider }))!.status).toBe(404);
    expect(calls).toEqual(["question:q-1", "question:q-2"]);
  });

  test("an invalid body is a 500, not a partial page", async () => {
    const provider: StatusProvider = {
      question: (id) =>
        ({
          source: "live",
          generatedAt: new Date().toISOString(),
          question: { ...card(id), issue: { id: "PAS-9", title: "", agent: "claude" } },
        }) as QuestionDetailResponse,
    };
    expect((await handleStatusRequest(get("/api/questions/q-1"), { provider }))!.status).toBe(500);
  });

  test("a warm cache is keyed by resource, question and reader, so a permission change reads again", async () => {
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
    await read("/api/questions", ["a"]);
    await read("/api/questions", ["a"]);
    await read("/api/questions/q-1", ["a"]);
    await read("/api/questions/q-1", ["a"]);
    await read("/api/questions/q-2", ["a"]);
    await read("/api/issues", ["a"]).catch(() => null);
    await read("/api/questions", ["b"]);
    await read("/api/questions/q-1", ["b"]);
    expect(calls).toEqual([
      "questions",
      "question:q-1",
      "question:q-2",
      "issues",
      "questions",
      "question:q-1",
    ]);
    now += 1_000;
    await read("/api/questions", ["a"]);
    expect(calls.at(-1)).toBe("questions");
  });
});
