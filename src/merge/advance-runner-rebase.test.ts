import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JOB_KIND } from "../core";
import { getWorkItem, listJobs, listRebaseReturns } from "../db";
import { setJournalSink } from "../journal";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";
import type { RunnerRebaseOutcome, RunnerRebaseRequest } from "./runner-rebase";

const COMMITTER = { name: "Paws", email: "1+paws[bot]@users.noreply.github.com" };

let harness: MergeHarness | undefined;
const scratch: string[] = [];

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function start(settings: Parameters<typeof mergeHarness>[0] = {}) {
  harness = await mergeHarness(settings);
  harness.state.commitEnv = {
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
  };
  return harness;
}

function runner(
  h: MergeHarness,
  answer: (request: RunnerRebaseRequest) => Promise<RunnerRebaseOutcome>,
) {
  const requests: RunnerRebaseRequest[] = [];
  h.state.runnerRebase = async (request) => {
    requests.push(request);
    return answer(request);
  };
  return requests;
}

async function runnerPush(
  h: MergeHarness,
  request: RunnerRebaseRequest,
  extra?: string,
): Promise<RunnerRebaseOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), "paws-fake-runner-"));
  scratch.push(dir);
  const run = (...args: string[]) =>
    h.git(dir, "-c", `user.name=${COMMITTER.name}`, "-c", `user.email=${COMMITTER.email}`, ...args);
  await h.git(tmpdir(), "clone", "-q", h.bare, dir);
  await run("checkout", "-q", "--detach", request.head);
  await run("rebase", "-q", request.main);
  if (extra !== undefined) {
    await writeFile(path.join(dir, "extra.txt"), extra);
    await run("add", ".");
    await run("commit", "-q", "--amend", "--no-edit");
  }
  await run(
    "push",
    "-q",
    `--force-with-lease=refs/heads/${request.branch}:${request.head}`,
    "origin",
    `HEAD:refs/heads/${request.branch}`,
  );
  return { outcome: "rebased", head: await run("rev-parse", "HEAD") };
}

function reverifyJobs(h: MergeHarness): string[] {
  return listJobs(h.db)
    .filter((job) => job.queue === JOB_KIND.reverify)
    .map((job) => job.jobKey ?? "");
}

describe("advanceMerge with a runner rebase", () => {
  test("the runner rebases and pushes, the lane verifies the new head and sends it to Closeout", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    const requests = runner(h, (request) => runnerPush(h, request));
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(requests).toEqual([
      {
        itemId: "ENG-1",
        repository: h.bare,
        branch: "paws/ENG-1",
        head: item.accepted,
        main,
        committer: COMMITTER,
        placementWaitMs: 600_000,
      },
    ]);
    const rebased = await h.remoteHead("ENG-1");
    expect(rebased).not.toBe(item.accepted);
    expect(await h.git(item.worktree, "rev-parse", "HEAD")).toBe(rebased);
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("verifying");
    expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${rebased}:merge:1`]);

    expect(await h.closeout("ENG-1")).toBe(rebased);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([rebased]);
    expect(requests).toHaveLength(1);
  });

  test("ci: the runner's head carries the acceptance and waits for CI", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    runner(h, (request) => runnerPush(h, request));
    h.state.ci = pendingCi;
    const step = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
  });

  test("a conflict on the runner goes back to the agent through the conflict return", async () => {
    const h = await start();
    await h.addItem("ENG-1", { file: "ok.txt", content: "agent\n" });
    const main = await h.moveMain("ok.txt", "from-main\n");
    runner(h, async () => ({ outcome: "conflict", files: ["ok.txt"] }));
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("queued");
    expect(
      listRebaseReturns(h.db, "ENG-1", 0).map((row) => ({ base: row.base, files: row.files })),
    ).toEqual([{ base: main, files: ["ok.txt"] }]);
  });

  test("a runner head whose patch-ids differ from the accepted head's is refused", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    runner(h, (request) => runnerPush(h, request, "smuggled\n"));
    const step = await h.pass("ENG-1");
    expect(step).toMatchObject({ kind: "failed", reason: "merge" });
    expect((step as { message: string }).message).toContain("patch-ids differ");
    expect(await h.git(item.worktree, "rev-parse", "HEAD")).toBe(item.accepted);
    expect(reverifyJobs(h)).toEqual([]);
    expect(h.github.merged).toEqual([]);
  });

  test("a runner head that does not descend from main is refused", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    runner(h, async () => ({ outcome: "rebased", head: item.accepted }));
    const step = await h.pass("ENG-1");
    expect((step as { message: string }).message).toContain("does not descend from main");
    expect(h.github.merged).toEqual([]);
  });

  test("with no eligible runner the lane rebases on the control plane and says so", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    const requests = runner(h, async () => ({ outcome: "unplaced" }));
    const logged: string[] = [];
    const restore = setJournalSink((line) => logged.push(line));
    try {
      expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    } finally {
      restore();
    }
    expect(requests).toHaveLength(1);
    const rebased = await h.remoteHead("ENG-1");
    expect(rebased).not.toBe(item.accepted);
    expect(await h.git(h.bare, "merge-base", "--is-ancestor", main, rebased)).toBe("");
    expect(logged.some((line) => line.includes("no runner was eligible within 10 minutes"))).toBe(
      true,
    );
  });
});
