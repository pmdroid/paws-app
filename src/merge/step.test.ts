import { describe, expect, test } from "bun:test";
import type { PullFacts, Readiness, RebaseResult, SerialMergeResult } from "../github";
import { mergeable, type MergeFacts } from "./mergeable";
import { laneTurn, serialMergeStep, type LaneTurn, type SerialMergeFacts } from "./step";

const S = "a".repeat(40);
const S2 = "c".repeat(40);
const MAIN = "b".repeat(40);

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    head: S,
    headMoved: false,
    accept: { head: S, policyDigest: "sha256:policy" },
    policyDigest: "sha256:policy",
    containsMain: true,
    ci: "green",
    unresolvedThreads: 0,
    protection: "satisfied",
    riskApproval: "not_required",
    ...overrides,
  };
}

function pull(readiness: Partial<Readiness> = {}, rest: Partial<PullFacts> = {}): PullFacts {
  return {
    branch: "paws/eng-1",
    head: S,
    base: MAIN,
    containsMain: true,
    readiness: { outcome: "ready", message: "CI passed", ...readiness },
    review: "none",
    ...rest,
  };
}

/** CI and thread facts as the lane derives them from a readiness read. */
function fromReadiness({ readiness }: PullFacts): Partial<MergeFacts> {
  return {
    ci:
      readiness.outcome === "ci_failed"
        ? "failed"
        : readiness.outcome === "ready" || readiness.unresolvedThreads !== undefined
          ? "green"
          : "pending",
    unresolvedThreads: readiness.unresolvedThreads ?? 0,
  };
}

/** A lane over fakes that records every action it takes. */
function fakeLane(
  judged: Partial<MergeFacts>,
  options: {
    read?: PullFacts;
    squash?: SerialMergeResult;
    rebase?: RebaseResult;
  } = {},
) {
  const calls: string[] = [];
  const turn = laneTurn({
    read: async () => {
      calls.push("read");
      return { kind: "facts", ...(options.read ?? pull()) };
    },
    facts: (read) => facts({ ...fromReadiness(read), ...judged }),
    rebase: async () => {
      calls.push("rebase");
      return options.rebase ?? { rebased: true, branch: "paws/eng-1", base: MAIN, head: S2 };
    },
    squash: async (head) => {
      calls.push(`squash:${head}`);
      return (
        options.squash ?? {
          merged: true,
          outcome: "merged",
          branch: "paws/eng-1",
          head,
          sha: "d".repeat(40),
        }
      );
    },
  });
  return { turn, calls };
}

function stepFor(turn: LaneTurn, rest: Partial<SerialMergeFacts> = {}) {
  return serialMergeStep({
    turn,
    queued: true,
    mainMoved: "closeout",
    rebaseBudget: { allowed: true, spent: 0 },
    ciFixes: 0,
    ciFixLimit: 3,
    ...rest,
  });
}

describe("mergeable(S)", () => {
  test("accept row for S under the current digest, green CI, S on main, no threads, protection", () => {
    expect(mergeable(facts())).toEqual({ ok: true });
  });

  test("each missing fact blocks the merge, in the order the lane acts on them", () => {
    expect(mergeable(facts({ headMoved: true, containsMain: false }))).toEqual({
      ok: false,
      block: "head_moved",
    });
    expect(mergeable(facts({ containsMain: false, accept: null, ci: "failed" }))).toEqual({
      ok: false,
      block: "behind_main",
    });
    expect(mergeable(facts({ accept: null }))).toEqual({ ok: false, block: "not_accepted" });
    expect(mergeable(facts({ ci: "failed" }))).toEqual({ ok: false, block: "ci_failed" });
    expect(mergeable(facts({ ci: "pending" }))).toEqual({ ok: false, block: "ci_pending" });
    expect(mergeable(facts({ unresolvedThreads: 2 }))).toEqual({
      ok: false,
      block: "review_threads",
    });
    expect(mergeable(facts({ protection: "review_required" }))).toEqual({
      ok: false,
      block: "protection",
    });
  });

  test("under overlap, a head behind main that main's commits do not touch is not behind", () => {
    expect(mergeable(facts({ containsMain: false, apart: true }))).toEqual({ ok: true });
    expect(mergeable(facts({ containsMain: false, apart: false }))).toEqual({
      ok: false,
      block: "behind_main",
    });
    expect(mergeable(facts({ containsMain: false, apart: true, accept: null }))).toEqual({
      ok: false,
      block: "not_accepted",
    });
  });

  test("an accept row for another head or another policy digest does not count", () => {
    expect(mergeable(facts({ accept: { head: S2, policyDigest: "sha256:policy" } }))).toEqual({
      ok: false,
      block: "not_accepted",
    });
    expect(mergeable(facts({ policyDigest: "sha256:changed" }))).toEqual({
      ok: false,
      block: "not_accepted",
    });
    expect(mergeable(facts({ policyDigest: null }))).toEqual({
      ok: false,
      block: "not_accepted",
    });
    // An acceptance with no recorded Closeout run is not under any known policy: verify S again.
    expect(mergeable(facts({ accept: { head: S, policyDigest: null } }))).toEqual({
      ok: false,
      block: "not_accepted",
    });
    expect(
      mergeable(facts({ accept: { head: S, policyDigest: null }, policyDigest: null })),
    ).toEqual({ ok: false, block: "not_accepted" });
  });
});

describe("merge lane turn", () => {
  test("a mergeable head is squashed with that head as the expected head, and nothing else", async () => {
    const lane = fakeLane({});
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read", `squash:${S}`]);
    expect(turn.kind).toBe("merged");
    expect(stepFor(turn)).toEqual({ step: { kind: "merged" }, leaveQueue: true });
  });

  test("a head behind main is rebased and sent to Closeout; the same turn never merges", async () => {
    const lane = fakeLane({ containsMain: false }, { read: pull({}, { containsMain: false }) });
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read", "rebase"]);
    expect(turn).toMatchObject({ kind: "rebased", base: MAIN, head: S2, accepted: true });
    expect(stepFor(turn)).toEqual({
      step: { kind: "reverify", head: S2, base: MAIN, rebased: true },
      leaveQueue: false,
    });
  });

  test("with ci, an accepted head the lane rebased carries the acceptance and waits for CI", async () => {
    const lane = fakeLane({ containsMain: false }, { read: pull({}, { containsMain: false }) });
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read", "rebase"]);
    expect(stepFor(turn, { mainMoved: "ci" })).toEqual({
      step: {
        kind: "carry",
        head: S2,
        base: MAIN,
        message: `Branch updated onto main ${MAIN.slice(0, 7)}, waiting for CI. Closeout does not run again, because "When main moved before the merge" for this task is set to wait for CI in Settings → Merging.`,
      },
      leaveQueue: false,
    });
  });

  test("with ci or overlap, a rebased head Closeout never accepted still goes to Closeout", async () => {
    const turn = await fakeLane(
      { containsMain: false, accept: null },
      { read: pull({}, { containsMain: false }) },
    ).turn;
    for (const mainMoved of ["ci", "overlap"] as const)
      expect(stepFor(turn, { mainMoved }).step).toEqual({
        kind: "reverify",
        head: S2,
        base: MAIN,
        rebased: true,
      });
  });

  test("with overlap, a head main's commits do not touch merges without a rebase", async () => {
    const lane = fakeLane(
      { containsMain: false, apart: true },
      { read: pull({}, { containsMain: false, apart: true, shared: [] }) },
    );
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read", `squash:${S}`]);
    expect(stepFor(turn, { mainMoved: "overlap" }).step).toEqual({ kind: "merged" });
  });

  test("with overlap, a shared file or GitHub's up-to-date rule rebases and names why", async () => {
    const shared = await fakeLane(
      { containsMain: false, apart: false },
      { read: pull({}, { containsMain: false, apart: false, shared: ["apps/web"] }) },
    ).turn;
    expect(stepFor(shared, { mainMoved: "overlap" }).step).toMatchObject({
      kind: "carry",
      head: S2,
      message: `Main changed apps/web, which this pull request changes too. Branch updated onto main ${MAIN.slice(0, 7)}, waiting for CI.`,
    });
    const rule = await fakeLane(
      { containsMain: false, apart: false },
      { read: pull({}, { containsMain: false, apart: false, shared: [], upToDateRule: true }) },
    ).turn;
    expect(stepFor(rule, { mainMoved: "overlap" }).step).toMatchObject({
      kind: "carry",
      message: expect.stringContaining("GitHub requires branches to be up to date"),
    });
  });

  test("no fact combination both rebases and squashes in one turn", async () => {
    const options = [true, false];
    for (const containsMain of options)
      for (const headMoved of options)
        for (const ci of ["green", "pending", "failed"] as const) {
          const lane = fakeLane({ containsMain, headMoved, ci });
          await lane.turn;
          const rebased = lane.calls.includes("rebase");
          const squashed = lane.calls.some((call) => call.startsWith("squash"));
          expect(rebased && squashed).toBe(false);
          expect(squashed).toBe(containsMain && !headMoved && ci === "green");
        }
  });

  test("a changed head releases the lane: no rebase, no squash, and the item keeps its place", async () => {
    const lane = fakeLane({ headMoved: true }, { read: pull({ outcome: "sha_moved" }) });
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read"]);
    expect(stepFor(turn)).toEqual({
      step: {
        kind: "wait",
        reason: "ci",
        message: "The pull request head changed before the merge. Reading it again.",
        base: MAIN,
        head: S,
      },
      leaveQueue: false,
    });
  });

  test("GitHub refusing the expected head (409) releases the lane without a retry", async () => {
    const lane = fakeLane(
      {},
      {
        squash: {
          merged: false,
          outcome: "sha_moved",
          branch: "paws/eng-1",
          head: S,
          message: "pull request head changed before merge",
        },
      },
    );
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read", `squash:${S}`]);
    expect(turn).toMatchObject({ kind: "blocked", block: "head_moved" });
    expect(stepFor(turn).step).toMatchObject({ kind: "wait", reason: "ci" });
  });

  test("main moving between the read and the squash releases the lane; the next turn rebases", async () => {
    const moved = "e".repeat(40);
    const lane = fakeLane(
      {},
      {
        squash: {
          merged: false,
          outcome: "sha_moved",
          branch: "paws/eng-1",
          base: moved,
          head: S,
          message: "main moved before merge",
        },
      },
    );
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read", `squash:${S}`]);
    expect(turn).toMatchObject({ kind: "blocked", block: "main_moved" });
    expect(stepFor(turn)).toEqual({
      step: {
        kind: "wait",
        reason: "ci",
        message: "Main moved before the merge. Reading it again.",
        base: MAIN,
        head: S,
      },
      leaveQueue: false,
    });
    const next = fakeLane(
      { containsMain: false },
      { read: pull({}, { base: moved, containsMain: false }) },
    );
    await next.turn;
    expect(next.calls).toEqual(["read", "rebase"]);
  });

  test("CI or threads changing on the read just before the squash release the lane, judged afresh", async () => {
    const failed = await fakeLane(
      {},
      {
        squash: {
          merged: false,
          outcome: "blocked",
          branch: "paws/eng-1",
          head: S,
          message: "CI failed on the candidate commit",
          readiness: {
            outcome: "ci_failed",
            message: "CI failed on the candidate commit",
            failedChecks: [{ name: "ci", url: null }],
          },
        },
      },
    ).turn;
    expect(failed).toMatchObject({
      kind: "blocked",
      block: "ci_failed",
      pull: { readiness: { outcome: "ci_failed" } },
    });
    expect(stepFor(failed).step).toEqual({ kind: "return", reason: "ci-failed" });

    // The lane's facts come from the fresh read, so the open thread is what blocks S.
    const threads = fakeLane(
      {},
      {
        squash: {
          merged: false,
          outcome: "blocked",
          branch: "paws/eng-1",
          head: S,
          message: "Waiting for 1 unresolved review thread(s).",
          readiness: {
            outcome: "pending",
            message: "Waiting for 1 unresolved review thread(s).",
            unresolvedThreads: 1,
          },
        },
      },
    );
    const turn = await threads.turn;
    expect(threads.calls).toEqual(["read", `squash:${S}`]);
    expect(turn).toMatchObject({ kind: "blocked", block: "review_threads" });
    expect(stepFor(turn).step).toMatchObject({ kind: "wait", reason: "review" });
  });

  test("pending CI waits on S and keeps the place", async () => {
    const lane = fakeLane(
      { ci: "pending" },
      { read: pull({ outcome: "pending", message: "Waiting for checks: ci." }) },
    );
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read"]);
    expect(stepFor(turn)).toEqual({
      step: {
        kind: "wait",
        reason: "ci",
        message: "Waiting for checks: ci.",
        base: MAIN,
        head: S,
      },
      leaveQueue: false,
    });
  });

  test("open review threads and branch protection wait without a deadline, out of the line", async () => {
    const threads = await fakeLane(
      { unresolvedThreads: 1 },
      {
        read: pull({
          outcome: "pending",
          message: "Waiting for 1 unresolved review thread(s).",
          unresolvedThreads: 1,
        }),
      },
    ).turn;
    expect(stepFor(threads)).toEqual({
      step: {
        kind: "wait",
        reason: "review",
        queued: true,
        message: "Waiting for 1 unresolved review thread(s).",
        base: MAIN,
        head: S,
      },
      leaveQueue: true,
    });
    const review = await fakeLane(
      { protection: "changes_requested" },
      { read: pull({}, { review: "changes_requested" }) },
    ).turn;
    expect(stepFor(review).step).toMatchObject({
      kind: "wait",
      reason: "review",
      message: "Changes were requested on the pull request. It merges once approved.",
    });
  });

  test("a head Closeout has not accepted goes back to Closeout in place", async () => {
    const lane = fakeLane({ accept: { head: S2, policyDigest: null } });
    const turn = await lane.turn;
    expect(lane.calls).toEqual(["read"]);
    expect(stepFor(turn)).toEqual({
      step: { kind: "reverify", head: S, base: MAIN, rebased: false },
      leaveQueue: false,
    });
  });

  test("failed CI returns to the agent, then asks once the fixes are spent", async () => {
    const turn = await fakeLane({ ci: "failed" }, { read: pull({ outcome: "ci_failed" }) }).turn;
    expect(stepFor(turn)).toEqual({
      step: { kind: "return", reason: "ci-failed" },
      leaveQueue: true,
    });
    expect(stepFor(turn, { ciFixes: 3 }).step).toEqual({ kind: "ask_ci" });
  });

  test("a rebase conflict returns to the agent until the rebase budget is spent", async () => {
    const conflict: RebaseResult = {
      rebased: false,
      result: { merged: false, outcome: "conflict", branch: "paws/eng-1", base: MAIN },
    };
    const turn = await fakeLane(
      { containsMain: false },
      { read: pull({}, { containsMain: false }), rebase: conflict },
    ).turn;
    expect(stepFor(turn).step).toEqual({ kind: "return", reason: "rebase-conflict" });
    expect(
      stepFor(turn, {
        rebaseBudget: { allowed: false, message: "The branch still conflicts." },
      }).step,
    ).toEqual({ kind: "ask_conflict", message: "The branch still conflicts." });
  });

  test("unreadable gates keep the place and retry; a closed pull request fails", async () => {
    const unreadable = await fakeLane(
      {},
      {
        read: pull({ outcome: "blocked", message: "could not read GitHub CI and review threads" }),
      },
    ).turn;
    expect(stepFor(unreadable)).toEqual({
      step: { kind: "unreadable", message: "could not read GitHub CI and review threads" },
      leaveQueue: false,
    });
    const closed = fakeLane(
      {},
      { read: pull({ outcome: "blocked", message: "pull request is no longer open" }) },
    );
    expect(stepFor(await closed.turn)).toEqual({
      step: { kind: "failed", message: "pull request is no longer open" },
      leaveQueue: true,
    });
    expect(closed.calls).toEqual(["read"]);
  });
});
