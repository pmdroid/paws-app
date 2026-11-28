import { expect, test } from "bun:test";
import { appBotCommitIdentity, commitAttributionCheck, type GitCommitPolicy } from "../core";
import { attributionRejectionLines, attributionReturnHandoff } from "./attribution-return";

const policy: GitCommitPolicy = {
  bot: { appId: "99", id: 88, login: "paws-test[bot]" },
  credit: null,
};
const bot = appBotCommitIdentity(policy.bot);
const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
const rejection = (commits: (readonly string[])[]) => {
  const check = commitAttributionCheck(policy);
  commits.forEach((metadata, n) => check.add(metadata, [], sha(n + 1)));
  try {
    check.assert();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

const refused =
  "Run failed during push: Commit attribution rejected. Candidate attribution rejected: Co-authored-by trailers must match the consenting identities in the run policy. Commit 0123456789ab has unexpected Co-authored-by: Claude <noreply@anthropic.com>; expected no Co-authored-by trailers. No candidate was rewritten.";

test("a trailer refusal returns the turn once with the precise rejection", () => {
  const handoff = attributionReturnHandoff(refused, undefined);
  expect(handoff).toContain(
    "Commit 0123456789ab has unexpected Co-authored-by: Claude <noreply@anthropic.com>",
  );
  expect(handoff).not.toContain("Run failed during push");
  expect(attributionReturnHandoff(refused, handoff!)).toBeNull();
  expect(attributionReturnHandoff("Run failed during push: Error.", undefined)).toBeNull();
  expect(attributionReturnHandoff(undefined, undefined)).toBeNull();
});

test("an identity refusal names each bad commit, its author and committer, and which failed", () => {
  const message = rejection([
    [bot.name, bot.email, bot.name, bot.email],
    ["Agent", "agent@example.test", bot.name, bot.email],
    [bot.name, bot.email, "Rewriter", "rewriter@example.test"],
  ]);
  const self = `${bot.name} <${bot.email}>`;
  expect(message).toContain(
    `commit=222222222222 author=Agent <agent@example.test> committer=${self} failed=author`,
  );
  expect(message).toContain(
    `commit=333333333333 author=${self} committer=Rewriter <rewriter@example.test> failed=committer`,
  );
  expect(message).not.toContain("111111111111");
  expect(
    attributionRejectionLines(`Run failed during push: ${message}`, "item-1", "run-1"),
  ).toEqual([
    `commit_attribution_rejected item=item-1 run=run-1 commit=222222222222 author=Agent <agent@example.test> committer=${self} failed=author`,
    `commit_attribution_rejected item=item-1 run=run-1 commit=333333333333 author=${self} committer=Rewriter <rewriter@example.test> failed=committer`,
  ]);
  expect(attributionRejectionLines(refused, "item-1", "run-1")).toEqual([]);
});

test("an identity refusal names the first five bad commits and counts the rest", () => {
  const message = rejection(
    Array.from({ length: 7 }, () => ["A", "a@example.test", "A", "a@example.test"]),
  );
  expect(attributionRejectionLines(message!, "item-1", "run-1")).toHaveLength(5);
  expect(message).toContain("555555555555");
  expect(message).not.toContain("666666666666");
  expect(message).toContain("; and 2 more. Repair metadata before verification");
});

test("a passing candidate is accepted", () => {
  expect(rejection([[bot.name, bot.email, policy.bot.login, bot.email]])).toBeNull();
});
