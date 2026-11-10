import { expect, test } from "bun:test";
import { isPermanentGitFailure } from "./transport";

test.each([
  ["a failed token request", "fetch failed"],
  ["a dropped socket", "socket hang up"],
  ["an error from Node", "Error: read ECONNRESET"],
  ["an unreachable host", "fatal: unable to access 'x': Could not resolve host: github.com"],
  ["a reset next to a ref error", "error: cannot lock ref 'a'\nConnection reset by peer"],
  ["a server error from the remote", "remote: Internal Server Error\nfatal: unable to access 'x'"],
])("%s is an outage", (_name, output) => {
  expect(isPermanentGitFailure(output)).toBe(false);
});

test.each([
  ["a missing promisor object", "fatal: could not fetch 914306a from promisor remote"],
  [
    "a pruned branch named like an outage",
    [
      "From /tmp/timeout/repo",
      " - [deleted]         (none)     -> test/timeout-fix",
      "   abc123..def456  bad-gateway -> bad-gateway",
      "warning: lazy fetching disabled; some objects may not be available",
      "fatal: fetch-pack: invalid index-pack output",
    ].join("\n"),
  ],
])("%s is permanent", (_name, output) => {
  expect(isPermanentGitFailure(output)).toBe(true);
});
