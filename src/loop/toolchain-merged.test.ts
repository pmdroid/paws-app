import { afterEach, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  bindWorkItemRepository,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  type Db,
} from "../db";
import { getQuestion } from "../questions";
import { formatToolchainQuestion } from "../runner-protocol";
import { tempStore } from "../../test/pglite";
import { acceptGitHubDelivery } from "./merge-jobs";
import { askSteps } from "./operations";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const TOOLCHAIN = formatToolchainQuestion({
  descriptions: ["package.json needs bun, which isn't installed on the runner."],
  file: "mise.toml",
  entries: [{ name: "bun", version: "1.4.4" }],
});

async function waiting(db: Db, id: string, repo: string, body: string, at: number) {
  await insertQueuedItem(db, { id, sessionKey: `ses-${id}`, now: at });
  await bindWorkItemRepository(db, id, {
    owner: "acme",
    repo,
    remoteUrl: `https://github.com/acme/${repo}.git`,
  });
  const { run } = await beginImplementRun(db, id, at);
  const { question } = await db.transaction((q) =>
    askSteps(q, { itemId: id, runId: run.id, sessionId: `ses-${id}` }, "agent", body, { now: at }),
  );
  expect((await getWorkItem(db, id))?.state).toBe("awaiting_input");
  return question.id;
}

function closed(deliveryId: string, merged: boolean, repo = "one") {
  const repository = { full_name: `acme/${repo}` };
  return {
    deliveryId,
    event: "pull_request",
    payload: JSON.stringify({
      action: "closed",
      repository: { ...repository, default_branch: "main" },
      pull_request: {
        merged,
        merged_at: merged ? new Date(5_000).toISOString() : null,
        head: { ref: "paws/toolchain", sha: "tools", repo: repository },
        base: { ref: "main", repo: repository },
      },
    }),
  };
}

async function setup() {
  const { db, close } = await tempStore();
  open.push(close);
  const questions = {
    first: await waiting(db, "first", "one", TOOLCHAIN, 1_000),
    second: await waiting(db, "second", "one", TOOLCHAIN, 2_000),
    other: await waiting(db, "other", "two", TOOLCHAIN, 1_000),
    ordinary: await waiting(db, "ordinary", "one", "Which widget should we count?", 1_000),
    newer: await waiting(db, "newer", "one", TOOLCHAIN, 9_000),
  };
  return { db, questions };
}

test("a merged toolchain pull request answers retry for the repository's waiting items", async () => {
  const { db, questions } = await setup();
  expect(await acceptGitHubDelivery(db, closed("merged", true), 10_000)).toBe(true);
  for (const id of ["first", "second"] as const) {
    expect((await getWorkItem(db, id))?.state).toBe("queued");
    expect(await getQuestion(db, questions[id])).toMatchObject({
      status: "answered",
      answer: "retry",
      answeredBy: "Paws",
      answerEventKey: "toolchain_merged:merged",
    });
  }
  for (const id of ["other", "ordinary", "newer"] as const) {
    expect((await getWorkItem(db, id))?.state).toBe("awaiting_input");
    expect((await getQuestion(db, questions[id]))?.status).toBe("open");
  }
  const resumes = (await listJobs(db)).filter(
    (job) => job.queue === JOB_KIND.resume && job.status === "pending",
  );
  expect(resumes.map((job) => (job.payload as { itemId: string }).itemId).sort()).toEqual([
    "first",
    "second",
  ]);

  expect(await acceptGitHubDelivery(db, closed("merged", true), 11_000)).toBe(false);
  expect(await acceptGitHubDelivery(db, closed("redelivered", true), 11_000)).toBe(true);
  expect((await getQuestion(db, questions.first))?.answerEventKey).toBe("toolchain_merged:merged");
  expect(
    (await listJobs(db)).filter((job) => job.queue === JOB_KIND.resume && job.status === "pending"),
  ).toHaveLength(2);
});

test("a toolchain pull request closed without merging resumes nothing", async () => {
  const { db, questions } = await setup();
  await acceptGitHubDelivery(db, closed("closed", false), 10_000);
  for (const id of Object.keys(questions) as (keyof typeof questions)[]) {
    expect((await getWorkItem(db, id))?.state).toBe("awaiting_input");
    expect((await getQuestion(db, questions[id]))?.status).toBe("open");
  }
});
