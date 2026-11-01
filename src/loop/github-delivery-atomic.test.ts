import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  bindWorkItemRepository,
  enqueueJob,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  joinMergeQueue,
  listGitHubDeliveries,
  listJobs,
  migrate,
  openDatabase,
  pendingChangeRequests,
  pendingPullComments,
  recordItemPullRequest,
  recordPullReview,
} from "../db";
import { acceptGitHubDelivery } from "./merge-jobs";
import { worktreeBranch } from "./sources";

function setup(file = ":memory:") {
  const db = openDatabase(file);
  migrate(db);
  for (const id of ["first", "second"]) {
    insertQueuedItem(db, { id, now: 1 });
    bindWorkItemRepository(db, id, {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    beginImplementRun(db, id, 1);
    enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "base", wipCommit: "head" });
    joinMergeQueue(db, { itemId: id, repository: "acme/one", now: id === "first" ? 1 : 2 });
    recordItemPullRequest(db, {
      itemId: id,
      pullNumber: id === "first" ? 7 : 8,
      pullUrl: null,
      openedAt: 1,
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: id, head: "head" },
      now: 1,
      runAt: 90_000,
    });
  }
  recordPullReview(db, {
    reviewId: 40,
    itemId: "first",
    state: "changes_requested",
    pullNumber: 7,
    head: "head",
    reviewer: "old",
    body: "Earlier feedback",
    receivedAt: 1,
  });
  const branch = worktreeBranch(getWorkItem(db, "first")!);
  const delivery = (kind: string) => ({
    deliveryId: "delivery",
    event:
      kind === "review"
        ? "pull_request_review"
        : kind === "comment"
          ? "pull_request_review_comment"
          : kind === "push"
            ? "push"
            : "pull_request",
    payload: JSON.stringify({
      repository: {
        id: 1,
        owner: { login: "acme" },
        name: "one",
        full_name: "acme/one",
        default_branch: "main",
      },
      pull_request: {
        number: 7,
        head: { ref: branch, sha: "head", repo: { id: 1 } },
        base: { ref: "main" },
        merged: true,
        merge_commit_sha: "new-main",
      },
      ref: "refs/heads/main",
      after: "new-main",
      action: kind === "review" ? "submitted" : kind === "comment" ? "created" : "closed",
      review: { id: 42, state: "changes_requested", body: "Fix it", user: { login: "reviewer" } },
      comment: { id: 43, body: "Fix it", user: { login: "reviewer" } },
    }),
  });
  return { db, delivery };
}
const failures = [
  ["receipt", "AFTER INSERT ON github_delivery", "review"],
  ["review", "AFTER INSERT ON pull_review", "review"],
  ["review job", `AFTER INSERT ON job WHEN NEW.queue = '${JOB_KIND.pullReview}'`, "review"],
  ["review deferral", `AFTER UPDATE ON job WHEN OLD.queue = '${JOB_KIND.pullReview}'`, "review"],
  ["comment", "AFTER INSERT ON pull_comment", "comment"],
  ["comment deferral", `AFTER UPDATE ON job WHEN OLD.queue = '${JOB_KIND.pullReview}'`, "comment"],
  ["comment job", `AFTER INSERT ON job WHEN NEW.queue = '${JOB_KIND.pullComments}'`, "comment"],
  ...["main", "push"].map((kind) => [
    `${kind} sweep`,
    `AFTER INSERT ON job WHEN NEW.queue = '${JOB_KIND.queueConflicts}'`,
    kind,
  ]),
  ...["review", "comment", "main"].map((kind) => [
    `${kind} second wake`,
    `AFTER UPDATE ON job WHEN OLD.queue = '${JOB_KIND.merge}' AND json_extract(OLD.payload, '$.itemId') = 'second'`,
    kind,
  ]),
];
for (const [name, point, kind] of failures) {
  test(`delivery retries atomically after failure at ${name}`, () => {
    const { db, delivery } = setup();
    try {
      const before = listJobs(db);
      db.run(
        `CREATE TEMP TRIGGER fail_delivery ${point} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
      );
      expect(() => acceptGitHubDelivery(db, delivery(kind!), 1_000)).toThrow("injected failure");
      expect(listGitHubDeliveries(db)).toEqual([]);
      expect(pendingChangeRequests(db, "first").map((r) => r.reviewId)).toEqual([40]);
      expect(pendingPullComments(db, "first")).toEqual([]);
      expect(listJobs(db)).toEqual(before);
      db.run("DROP TRIGGER fail_delivery");
      expect(acceptGitHubDelivery(db, delivery(kind!), 1_000)).toBe(true);
      expect(listGitHubDeliveries(db)).toHaveLength(1);
      expect(pendingChangeRequests(db, "first")).toHaveLength(kind === "review" ? 2 : 1);
      expect(pendingPullComments(db, "first")).toHaveLength(kind === "comment" ? 1 : 0);
      const queue =
        kind === "review"
          ? JOB_KIND.pullReview
          : kind === "comment"
            ? JOB_KIND.pullComments
            : JOB_KIND.queueConflicts;
      expect(listJobs(db).filter((j) => j.queue === queue)).toHaveLength(kind === "review" ? 2 : 1);
      expect(
        listJobs(db)
          .filter((j) => j.queue === JOB_KIND.merge)
          .map((j) => j.runAt),
      ).toEqual(kind === "push" ? [90_000, 90_000] : [1_000, 1_000]);
      const committed = listJobs(db);
      expect(acceptGitHubDelivery(db, delivery(kind!), 2_000)).toBe(false);
      expect(listJobs(db)).toEqual(committed);
    } finally {
      db.close();
    }
  });
}
test("failure after receipt insertion leaves the delivery retryable", () => {
  const { db, delivery } = setup();
  const run = db.run.bind(db);
  try {
    db.run = (sql, ...args) => {
      const result = run(sql, ...args);
      if (sql.includes("INSERT INTO github_delivery")) throw new Error("after receipt");
      return result;
    };
    expect(() => acceptGitHubDelivery(db, delivery("review"), 1_000)).toThrow("after receipt");
    expect(listGitHubDeliveries(db)).toEqual([]);
    db.run = run;
    expect(acceptGitHubDelivery(db, delivery("review"), 1_000)).toBe(true);
    expect(pendingChangeRequests(db, "first")).toHaveLength(2);
  } finally {
    db.close();
  }
});
for (const kind of ["review", "comment", "main"]) {
  test(`process death during ${kind} rolls back receipt and effects on reopen`, () => {
    const root = mkdtempSync(join(tmpdir(), "paws-delivery-crash-"));
    const file = join(root, "paws.db");
    try {
      const { db, delivery } = setup(file);
      const before = listJobs(db);
      const input = delivery(kind);
      db.close();
      const child = Bun.spawnSync([
        process.execPath,
        "-e",
        `
        import { openDatabase } from ${JSON.stringify(new URL("../db/index.ts", import.meta.url).pathname)};
        import { acceptGitHubDelivery } from ${JSON.stringify(new URL("./merge-jobs.ts", import.meta.url).pathname)};
        const db = openDatabase(${JSON.stringify(file)});
        const run = db.run.bind(db);
        db.run = (sql, ...args) => {
          const result = run(sql, ...args);
          if (sql.includes("UPDATE job SET run_at = CASE")) process.kill(process.pid, "SIGKILL");
          return result;
        };
        acceptGitHubDelivery(db, ${JSON.stringify(input)}, 1000);
        process.exit(99);
      `,
      ]);
      expect(child.signalCode, child.stderr.toString()).toBe("SIGKILL");
      const reopened = openDatabase(file);
      try {
        expect(listGitHubDeliveries(reopened)).toEqual([]);
        expect(listJobs(reopened)).toEqual(before);
        expect(pendingChangeRequests(reopened, "first").map((r) => r.reviewId)).toEqual([40]);
        expect(pendingPullComments(reopened, "first")).toEqual([]);
        expect(acceptGitHubDelivery(reopened, input, 1_000)).toBe(true);
        expect(acceptGitHubDelivery(reopened, input, 2_000)).toBe(false);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test("filter and identity refresh callbacks run outside the write transaction, never for duplicates", () => {
  const { db, delivery } = setup();
  const calls: string[] = [];
  const check = (name: string) => {
    expect(db.inTransaction).toBe(false);
    calls.push(name);
  };
  const filter = {
    appId: () => {
      check("id");
      return null;
    },
    appLogin: () => {
      check("identity refresh");
      return null;
    },
    ignoredBots: () => {
      check("ignored");
      return [];
    },
    commentWait: () => {
      check("wait");
      return { quietMs: 20, maxMs: 100 };
    },
  };
  try {
    expect(acceptGitHubDelivery(db, delivery("comment"), 1_000, filter)).toBe(true);
    expect(calls).toContain("identity refresh");
    expect(listJobs(db).find((j) => j.queue === JOB_KIND.pullComments)?.runAt).toBe(1_020);
    const before = [...calls];
    expect(acceptGitHubDelivery(db, delivery("comment"), 2_000, filter)).toBe(false);
    expect(calls).toEqual(before);
  } finally {
    db.close();
  }
});
