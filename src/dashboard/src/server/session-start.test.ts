import { expect, test } from "bun:test";
import { handleStatusRequest } from "../engine";
import { parseLinearSessionTarget } from "../session-start";

const comment = "bac3f259-220f-4671-a193-42c764c92f23";
const base = "http://127.0.0.1:8787";

function request(target = "eng-123", extra: RequestInit = {}) {
  return new Request(`${base}/api/linear/sessions`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify({ target }),
    ...extra,
  });
}

test("issue and comment links select the explicit Linear target", () => {
  expect(parseLinearSessionTarget("eng-123")).toEqual({ kind: "issue", id: "ENG-123" });
  expect(parseLinearSessionTarget("https://linear.app/team/issue/ENG-123/title")).toEqual({
    kind: "issue",
    id: "ENG-123",
  });
  expect(
    parseLinearSessionTarget(`https://linear.app/team/issue/ENG-123/title#comment-${comment}`),
  ).toEqual({ kind: "comment", id: comment });
  for (const input of [
    "https://linear.app.attacker/issue/ENG-123",
    "http://linear.app/issue/ENG-123",
    "https://secret@linear.app/issue/ENG-123",
    "https://linear.app/not-an-issue",
    "https://linear.app/team/issue/ENG-123/title#unrelated",
  ])
    expect(() => parseLinearSessionTarget(input)).toThrow();
});

test("local CSRF protected creation passes the selected thread to the host callback", async () => {
  const calls: unknown[] = [];
  const response = await handleStatusRequest(
    request(`https://linear.app/team/issue/ENG-123/title#comment-${comment}`),
    {
      csrfToken: "csrf",
      async startLinearSession(...args) {
        calls.push(args);
        return { id: "session", url: "https://linear.app/team/issue/ENG-123/title" };
      },
    },
  );
  expect(response?.status).toBe(201);
  expect(calls[0]).toEqual([
    { kind: "comment", id: comment },
    `${base}/status/`,
    expect.any(AbortSignal),
  ]);
  expect(response?.headers.get("access-control-allow-origin")).toBeNull();
  expect(response?.headers.get("cache-control")).toBe("no-store");
});

test("remote, cross-origin, missing CSRF and malformed writes cannot create sessions", async () => {
  let calls = 0;
  const options = {
    csrfToken: "csrf",
    async startLinearSession() {
      calls++;
      return { id: "session", url: null };
    },
  };
  for (const write of [
    new Request("https://remote.example/api/linear/sessions", { method: "POST" }),
    request("ENG-1", { headers: { origin: "https://attacker.example", "x-paws-csrf": "csrf" } }),
    request("ENG-1", { headers: { host: "attacker.example", "x-paws-csrf": "csrf" } }),
    request("ENG-1", { headers: { "sec-fetch-site": "cross-site", "x-paws-csrf": "csrf" } }),
    request("ENG-1", { headers: { "content-type": "application/json" } }),
  ])
    expect((await handleStatusRequest(write, options))?.status).toBe(403);
  expect((await handleStatusRequest(request("wrong"), options))?.status).toBe(400);
  expect((await handleStatusRequest(request("x".repeat(5000)), options))?.status).toBe(400);
  expect(calls).toBe(0);
  expect((await handleStatusRequest(request(), { csrfToken: "csrf" }))?.status).toBe(503);
});

test("availability and sanitized failures preserve connection credentials", async () => {
  const available = await handleStatusRequest(new Request(`${base}/api/linear/sessions`), {});
  expect(await available?.json()).toEqual({ available: false });
  const failed = await handleStatusRequest(request(), {
    csrfToken: "csrf",
    async startLinearSession() {
      throw new Error("secret-token");
    },
  });
  expect(failed?.status).toBe(502);
  expect(await failed?.text()).not.toContain("secret-token");
});
