import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
  pendingChangeRequests,
  pendingPullComments,
  recordItemPullRequest,
  recordPullReview,
  type Db,
  type PgDb,
} from "../db";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";
import { acceptGitHubDelivery } from "./merge-jobs";
import { worktreeBranch } from "./sources";

async function setup() {
  const { db, close } = await tempStore();
  for (const id of ["first", "second"]) {
    await insertQueuedItem(db, { id, now: 1 });
    await bindWorkItemRepository(db, id, {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    await beginImplementRun(db, id, 1);
    await enterMergeQueue(db, id, {
      phase: "merge_queue",
      baseSha: "base",
      wipCommit: "head",
    });
    await joinMergeQueue(db, {
      itemId: id,
      repository: "acme/one",
      now: id === "first" ? 1 : 2,
    });
    await recordItemPullRequest(db, {
      itemId: id,
      pullNumber: id === "first" ? 7 : 8,
      pullUrl: null,
      openedAt: 1,
    });
    await enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: id, head: "head" },
      now: 1,
      runAt: 90_000,
    });
  }
  await recordPullReview(db, {
    reviewId: 40,
    itemId: "first",
    state: "changes_requested",
    pullNumber: 7,
    head: "head",
    reviewer: "old",
    body: "Earlier feedback",
    receivedAt: 1,
  });
  const branch = worktreeBranch((await getWorkItem(db, "first"))!);
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
  return { db, close, delivery };
}

const exec = (db: Db, statement: string) => (db as PgDb).orm.execute(sql.raw(statement));

async function failAt(db: Db, message: string, point: string) {
  const [on, when] = point.split(" WHEN ");
  await exec(db, "SET session_replication_role = origin");
  await exec(
    db,
    `CREATE FUNCTION fail_delivery() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$ LANGUAGE plpgsql`,
  );
  await exec(
    db,
    `CREATE TRIGGER fail_delivery ${on} FOR EACH ROW ${when ? `WHEN ${when}` : ""} EXECUTE FUNCTION fail_delivery()`,
  );
  return () => exec(db, `DROP TRIGGER fail_delivery ON ${on!.split(" ON ")[1]}`);
}

async function rejects(work: Promise<unknown>, message: string) {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ cause: { message } });
}

const failures = [
  ["receipt", "AFTER INSERT ON github_delivery", "review"],
  ["review", "AFTER INSERT ON pull_review", "review"],
  ["review job", `AFTER INSERT ON job WHEN (NEW.queue = '${JOB_KIND.pullReview}')`, "review"],
  ["review deferral", `AFTER UPDATE ON job WHEN (OLD.queue = '${JOB_KIND.pullReview}')`, "review"],
  ["comment", "AFTER INSERT ON pull_comment", "comment"],
  [
    "comment deferral",
    `AFTER UPDATE ON job WHEN (OLD.queue = '${JOB_KIND.pullReview}')`,
    "comment",
  ],
  ["comment job", `AFTER INSERT ON job WHEN (NEW.queue = '${JOB_KIND.pullComments}')`, "comment"],
  ...["main", "push"].map((kind) => [
    `${kind} sweep`,
    `AFTER INSERT ON job WHEN (NEW.queue = '${JOB_KIND.queueConflicts}')`,
    kind,
  ]),
  ...["review", "comment", "main"].map((kind) => [
    `${kind} second wake`,
    `AFTER UPDATE ON job WHEN (OLD.queue = '${JOB_KIND.merge}' AND OLD.payload->>'itemId' = 'second')`,
    kind,
  ]),
];

async function expectUntouched(db: Db, before: unknown) {
  expect(await listGitHubDeliveries(db)).toEqual([]);
  expect((await pendingChangeRequests(db, "first")).map((r) => r.reviewId)).toEqual([40]);
  expect(await pendingPullComments(db, "first")).toEqual([]);
  expect(await listJobs(db)).toEqual(before);
}

for (const [name, point, kind] of failures) {
  test(`delivery retries atomically after failure at ${name}`, async () => {
    const { db, close, delivery } = await setup();
    try {
      const before = await listJobs(db);
      const drop = await failAt(db, "injected failure", point!);
      await rejects(acceptGitHubDelivery(db, delivery(kind!), 1_000), "injected failure");
      await expectUntouched(db, before);
      await drop();
      expect(await acceptGitHubDelivery(db, delivery(kind!), 1_000)).toBe(true);
      expect(await listGitHubDeliveries(db)).toHaveLength(1);
      expect(await pendingChangeRequests(db, "first")).toHaveLength(kind === "review" ? 2 : 1);
      expect(await pendingPullComments(db, "first")).toHaveLength(kind === "comment" ? 1 : 0);
      const queue =
        kind === "review"
          ? JOB_KIND.pullReview
          : kind === "comment"
            ? JOB_KIND.pullComments
            : JOB_KIND.queueConflicts;
      expect((await listJobs(db)).filter((j) => j.queue === queue)).toHaveLength(
        kind === "review" ? 2 : 1,
      );
      expect(
        (await listJobs(db)).filter((j) => j.queue === JOB_KIND.merge).map((j) => j.runAt),
      ).toEqual(kind === "push" ? [90_000, 90_000] : [1_000, 1_000]);
      const committed = await listJobs(db);
      expect(await acceptGitHubDelivery(db, delivery(kind!), 2_000)).toBe(false);
      expect(await listJobs(db)).toEqual(committed);
    } finally {
      await close();
    }
  });
}

test("failure after receipt insertion leaves the delivery retryable", async () => {
  const { db, close, delivery } = await setup();
  try {
    await seed(db, (q) =>
      q.orm.insert(q.t.githubDelivery).values({
        deliveryId: "expired",
        event: "push",
        payload: "{}",
        receivedAt: -300_000_000,
      }),
    );
    const drop = await failAt(db, "after receipt", "BEFORE DELETE ON github_delivery");
    await rejects(acceptGitHubDelivery(db, delivery("review"), 1_000), "after receipt");
    expect((await listGitHubDeliveries(db)).map((row) => row.deliveryId)).toEqual(["expired"]);
    await drop();
    expect(await acceptGitHubDelivery(db, delivery("review"), 1_000)).toBe(true);
    expect(await pendingChangeRequests(db, "first")).toHaveLength(2);
  } finally {
    await close();
  }
});

for (const kind of ["review", "comment", "main"]) {
  test(`a ${kind} delivery that dies before commit rolls back receipt and effects`, async () => {
    const { db, close, delivery } = await setup();
    try {
      const before = await listJobs(db);
      const input = delivery(kind);
      const dying: Db = {
        ...db,
        transaction: (body) =>
          db.transaction(function* (q) {
            yield* body(q);
            throw new Error("died before commit");
          }),
      } as Db;
      await expect(acceptGitHubDelivery(dying, input, 1_000)).rejects.toThrow("died before commit");
      await expectUntouched(db, before);
      expect(await acceptGitHubDelivery(db, input, 1_000)).toBe(true);
      expect(await acceptGitHubDelivery(db, input, 2_000)).toBe(false);
    } finally {
      await close();
    }
  });
}

test("filter and identity refresh callbacks run outside the write transaction, never for duplicates", async () => {
  const { db, close, delivery } = await setup();
  let open = 0;
  const store = {
    ...db,
    transaction: async (body) => {
      open += 1;
      try {
        return await db.transaction(body);
      } finally {
        open -= 1;
      }
    },
  } as Db;
  const calls: string[] = [];
  const check = (name: string) => {
    expect(open).toBe(0);
    calls.push(name);
  };
  const filter = {
    appId: async () => {
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
    ignoredMarkers: () => {
      check("markers");
      return [];
    },
    commentWait: () => {
      check("wait");
      return { quietMs: 20, maxMs: 100 };
    },
  };
  try {
    expect(await acceptGitHubDelivery(store, delivery("comment"), 1_000, filter)).toBe(true);
    expect(calls).toContain("identity refresh");
    expect((await listJobs(db)).find((j) => j.queue === JOB_KIND.pullComments)?.runAt).toBe(1_020);
    const before = [...calls];
    expect(await acceptGitHubDelivery(store, delivery("comment"), 2_000, filter)).toBe(false);
    expect(calls).toEqual(before);
  } finally {
    await close();
  }
});
