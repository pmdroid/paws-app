import { expect, test } from "bun:test";
import {
  fakeMergeReadiness,
  fakeRequiredChecks,
  readPullCi,
  type FakeCheckContext,
  type GitHubClient,
} from "../github";
import { ciForRecheck, ciPattern, fromGreenCi, type CiMapping } from "./ci-recheck";

const HEAD = "a".repeat(40);
const RUNS = "https://github.com/pmdroid/paws-app/actions/runs";
const CHECK_JOB = "lint, format, types, test, dashboard build";
const MAPPINGS: CiMapping[] = [
  { id: "lint", ci: CHECK_JOB },
  { id: "test", ci: "test (*)" },
];

const job = (name: string, conclusion: string | null, id: number): FakeCheckContext => ({
  name,
  conclusion,
  detailsUrl: `${RUNS}/77/job/${id}`,
});

/** The GitHub fake answering each readiness read with the next of `polls`. */
function github(polls: FakeCheckContext[][]): { client: GitHubClient; reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      async request(request) {
        if (request.path !== "/graphql") {
          const required = fakeRequiredChecks(request);
          if (required) return required;
          return { status: 404, body: {} };
        }
        const body = fakeMergeReadiness(HEAD);
        body.data.repository.object.statusCheckRollup.contexts.nodes =
          polls[Math.min(reads, polls.length - 1)]!;
        reads += 1;
        return { status: 200, body };
      },
    },
  };
}

function recheck(client: GitHubClient, sleeps: number[] = [], mappings = MAPPINGS) {
  const waits: string[] = [];
  let now = 0;
  return {
    waits,
    result: ciForRecheck({
      mappings,
      read: () =>
        readPullCi({
          client,
          owner: "pmdroid",
          repo: "paws-app",
          prNumber: 7,
          head: HEAD,
          tokenProvider: { mode: "app", tokenFor: async () => "synthetic-token" },
        }),
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
      pollMs: 1_000,
      maxWaitMs: 5_000,
      onWait: (message) => waits.push(message),
    }),
  };
}

test("green CI gives each mapped check its run and conclusions; an unmapped check runs", async () => {
  const fake = github([
    [
      job("test (0/4)", "SUCCESS", 1),
      job("test (1/4)", "SUCCESS", 2),
      job(CHECK_JOB, "SUCCESS", 3),
      job("deploy preview", "SUCCESS", 4),
    ],
  ]);
  expect(await recheck(fake.client).result).toEqual({
    kind: "check",
    fromCi: [
      {
        id: "lint",
        run: `${RUNS}/77`,
        checks: [{ name: CHECK_JOB, conclusion: "success", url: `${RUNS}/77/job/3` }],
      },
      {
        id: "test",
        run: `${RUNS}/77`,
        checks: [
          { name: "test (0/4)", conclusion: "success", url: `${RUNS}/77/job/1` },
          { name: "test (1/4)", conclusion: "success", url: `${RUNS}/77/job/2` },
        ],
      },
    ],
  });
  expect(fake.reads()).toBe(1);
});

test("pending CI is waited for rather than running the checks", async () => {
  const fake = github([
    [job("test (0/4)", null, 1), job(CHECK_JOB, null, 3)],
    [job("test (0/4)", "SUCCESS", 1), job(CHECK_JOB, null, 3)],
    [job("test (0/4)", "SUCCESS", 1), job(CHECK_JOB, "SUCCESS", 3)],
  ]);
  const sleeps: number[] = [];
  const read = recheck(fake.client, sleeps);
  const result = await read.result;
  expect(result.kind).toBe("check");
  expect(result.kind === "check" && result.fromCi.map((entry) => entry.id)).toEqual([
    "lint",
    "test",
  ]);
  expect(sleeps).toEqual([1_000, 1_000]);
  expect(read.waits).toEqual([
    `Waiting for checks: ${CHECK_JOB}, test (0/4).`,
    `Waiting for checks: ${CHECK_JOB}.`,
  ]);
});

test("CI still pending at the deadline runs the checks", async () => {
  const fake = github([[job("test (0/4)", null, 1)]]);
  expect(await recheck(fake.client).result).toEqual({ kind: "check", fromCi: [] });
  expect(fake.reads()).toBe(6);
});

test("red CI goes to the CI fix", async () => {
  const fake = github([[job("test (0/4)", "FAILURE", 1), job(CHECK_JOB, null, 3)]]);
  expect(await recheck(fake.client).result).toEqual({
    kind: "ci-failed",
    checks: [
      expect.objectContaining({ name: "test (0/4)", url: `${RUNS}/77/job/1`, failsOnBase: false }),
    ],
  });
});

test("a policy without ci mappings reads nothing", async () => {
  const fake = github([[job("test (0/4)", "SUCCESS", 1)]]);
  expect(await recheck(fake.client, [], []).result).toEqual({ kind: "check", fromCi: [] });
  expect(fake.reads()).toBe(0);
});

test("a mapping with no match or a skipped match is not taken from CI", () => {
  expect(
    fromGreenCi(MAPPINGS, [
      { name: "test (0/4)", conclusion: "SUCCESS", url: null },
      { name: "test (1/4)", conclusion: "SKIPPED", url: null },
    ]),
  ).toEqual([]);
});

test("a ci pattern matches the whole name, with * as any text", () => {
  expect(ciPattern("test (*)").test("test (2/4)")).toBe(true);
  expect(ciPattern("test (*)").test("e2e test (2/4)")).toBe(false);
  expect(ciPattern(CHECK_JOB).test(CHECK_JOB)).toBe(true);
  expect(ciPattern("lint").test("lint, format")).toBe(false);
});
