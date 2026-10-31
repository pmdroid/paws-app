import { describe, expect, test } from "bun:test";
import { isTransient, resumeRetrySpreadMs } from "./failure";
import { PawsShutdown, RunnerSlotsBusyError } from "./user-facing-error";

function named(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe("isTransient", () => {
  test.each([
    ["a Linear rate limit", named("LinearRateLimitError", "Linear GraphQL: RATELIMITED")],
    ["a runner that restarted or lost its lease", named("RunnerWorkFencedError")],
    ["a runner failover that ran out of runners", named("RetryableRunnerError")],
    ["an agent usage limit", named("UsageLimitPause")],
    ["no paired runner right now", named("RunnerUnavailableError")],
    [
      "a Git fetch that kept timing out",
      new Error("fetch failed: Connection timed out", { cause: named("GitTransportError") }),
    ],
    ["Paws restarting", new PawsShutdown()],
    ["a request timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ["a reset connection", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    [
      "a failed fetch with a network cause",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
    ],
    ["a failed fetch without a cause", new TypeError("fetch failed")],
    ["a server error status", Object.assign(new Error("GitHub 502"), { status: 502 })],
    ["a secondary rate limit status", Object.assign(new Error("GitHub 429"), { status: 429 })],
    [
      "a transient cause wrapped twice",
      new Error("outer", { cause: new Error("middle", { cause: named("TimeoutError") }) }),
    ],
  ])("%s is transient", (_label, error) => {
    expect(isTransient(error)).toBe(true);
  });

  test.each([
    ["a plain error", new Error("Implementer did not report a concrete session model")],
    ["an illegal transition", named("TransitionRejectedError", "illegal_transition")],
    ["a user-facing refusal", new RunnerSlotsBusyError()],
    ["a client error status", Object.assign(new Error("GitHub 404"), { status: 404 })],
    ["a git failure", named("GitCommandError", "git push failed")],
    ["a string", "RATELIMITED"],
    ["nothing", undefined],
    [
      "a transient cause nested too deep",
      new Error("1", {
        cause: new Error("2", {
          cause: new Error("3", { cause: new Error("4", { cause: named("TimeoutError") }) }),
        }),
      }),
    ],
  ])("%s is terminal", (_label, error) => {
    expect(isTransient(error)).toBe(false);
  });
});

// Keep core independent of adapters while checking their public error shape.
describe("HTTP statuses and rate-limit bodies", () => {
  test.each([
    [200, {}, false],
    [200, "secondary rate limit", false],
    [200, { message: "API rate limit exceeded" }, false],
    [400, { message: "Bad request" }, false],
    [401, { message: "Bad credentials" }, false],
    [403, { message: "Resource not accessible by integration" }, false],
    [404, {}, false],
    [422, {}, false],
    [429, {}, true],
    [500, {}, true],
    [502, {}, true],
    [503, {}, true],
    [504, {}, true],
    [599, {}, true],
    [600, {}, false],
    [403, { message: "You have exceeded a secondary rate limit." }, true],
    [403, { message: "API rate limit exceeded" }, true],
    [200, { errors: [{ type: "RATELIMITED", message: "Try again later" }] }, true],
    [200, { errors: [{ extensions: { code: "RATELIMITED" } }] }, true],
    [403, "You have exceeded a secondary rate limit", true],
    [403, { message: "Forbidden", documentation_url: "https://docs/rate-limits" }, false],
  ])("status %d, body %j is transient: %s", (status, body, expected) => {
    const error = Object.assign(new Error("GitHub request failed"), {
      name: "GitHubHttpError",
      status,
      body,
    });
    expect(isTransient(error)).toBe(expected);
    expect(isTransient(new Error("wrapped", { cause: error }))).toBe(expected);
  });

  test("legacy Linear RATELIMITED errors use the shared classifier", () => {
    expect(isTransient(new Error("Linear GraphQL: RATELIMITED"))).toBe(true);
  });

  test("transient git stderr uses the shared classifier", () => {
    expect(
      isTransient(
        Object.assign(new Error("git failed"), { stderr: "remote: Service unavailable" }),
      ),
    ).toBe(true);
  });
});

test("resume retry spread keeps at least eighty percent of the delay and caps spread at five seconds", () => {
  expect(resumeRetrySpreadMs(1, () => 0.99)).toBe(0);
  expect(resumeRetrySpreadMs(5_000, () => 0)).toBe(0);
  expect(resumeRetrySpreadMs(5_000, () => 0.99)).toBe(990);
  expect(resumeRetrySpreadMs(60_000, () => 0.99)).toBe(4_950);
});
