import { expect, test } from "bun:test";
import { followUpCi } from "./follow-up-ci";

const PULL = { number: 3, url: null };
const HEAD = "c".repeat(40);

test("a closed pull request adds no CI section and reads no CI", async () => {
  let reads = 0;
  const section = await followUpCi({
    pull: PULL,
    readPull: async () => ({ head: HEAD, open: false, merges: "clean" }),
    readCi: async () => {
      reads += 1;
      return { state: "failed", failedChecks: [{ name: "test", url: null }], checks: [] };
    },
    now: () => 0,
  });
  expect(section).toBeNull();
  expect(reads).toBe(0);
});

test("an unreadable pull request says CI is unknown without naming a head", async () => {
  const section = await followUpCi({
    pull: PULL,
    readPull: async () => null,
    readCi: async () => ({ state: "green", checks: [] }),
    now: () => 0,
  });
  expect(section).toEqual({
    head: null,
    section:
      "Pull request #3: Paws could not read CI (GitHub did not return the pull request). Its CI result is unknown; do not assume it passed or failed.",
  });
});

test("failed CI reads CI on the pull request's own head and redacts given secrets from log tails", async () => {
  const heads: string[] = [];
  const section = await followUpCi({
    pull: PULL,
    readPull: async () => ({ head: HEAD, open: true, merges: "clean" }),
    readCi: async (head) => {
      heads.push(head);
      return {
        state: "failed",
        failedChecks: [{ name: "test", url: null, logTail: "key=-----private-material-----" }],
        checks: [],
      };
    },
    now: () => Date.UTC(2026, 10, 3),
    secrets: ["-----private-material-----"],
  });
  expect(heads).toEqual([HEAD]);
  expect(section?.head).toBe(HEAD);
  expect(section?.section).toStartWith(
    `Pull request #3: Paws read CI on head ${HEAD} from GitHub at 2026-11-03T00:00:00.000Z.`,
  );
  expect(section?.section).toContain("- test");
  expect(section?.section).not.toContain("private-material");
});
