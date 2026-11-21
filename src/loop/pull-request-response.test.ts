import { expect, test } from "bun:test";
import { pullRequestReadyResponse, type FiledFollowUp } from "./pull-request-response";

const opened =
  "Opened https://github.com/o/r/pull/7. CI checks and merging will continue in the background. Reply here to request changes.";

const response = (filed: readonly FiledFollowUp[]) =>
  pullRequestReadyResponse({
    itemId: "item",
    head: "abc",
    pull: { number: 7, url: "https://github.com/o/r/pull/7" },
    risk: null,
    openLine: "",
    filed,
  });

const followUp = (n: number): FiledFollowUp => ({
  identifier: `PAS-${n}`,
  title: `Title ${n}`,
  url: null,
  started: false,
});

test("the pull request response lists no follow-ups when none were filed", async () => {
  expect(await response([])).toBe(
    `${opened}\n\nRisk: unknown — Paws could not read the paths this change touches`,
  );
});

test("the pull request response lists follow-ups after the Opened line", async () => {
  const body = await response([
    { ...followUp(2301), url: "https://linear.app/x/issue/PAS-2301", started: true },
    followUp(2302),
  ]);
  expect(body).toBe(
    [
      opened,
      [
        "Follow-ups filed from this work:",
        "- [PAS-2301](https://linear.app/x/issue/PAS-2301): Title 2301 (handed to Paws)",
        "- PAS-2302: Title 2302",
      ].join("\n"),
      "Risk: unknown — Paws could not read the paths this change touches",
    ].join("\n\n"),
  );
});

test("the pull request response lists at most ten follow-ups", async () => {
  const body = await response(Array.from({ length: 12 }, (_, n) => followUp(n + 1)));
  const lines = body.split("\n\n")[1]!.split("\n");
  expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(10);
  expect(lines.at(-2)).toBe("- PAS-10: Title 10");
  expect(lines.at(-1)).toBe("and 2 more.");
});
