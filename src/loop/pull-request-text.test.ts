import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  enqueueJob,
  getPullRequestDraft,
  getPullRequestText,
  migrate,
  openDatabase,
  recordItemPullRequest,
  savePullRequestDraft,
  savePullRequestText,
  sqliteDb,
} from "../db";
import { openPullRequest, publishedPullRequestBody, type GitHubBinding } from "../github";
import { intakeDelegatedIssue } from "../intake";
import { createFakeTracker } from "../linear";
import { applyPullRequestDraft } from "./pull-request-text";

const EVIDENCE = "## Closeout\n\nAll checks passed at 474f2d1b.";

async function fixture(
  options: {
    pull?: boolean;
    stored?: boolean;
    status?: number;
    patch?: Promise<void>;
    state?: string;
    savedDescription?: string;
  } = {},
) {
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "DEP-686",
      title: "Grade release races",
      description: null,
      subIssues: [],
    },
  ]);
  const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue" });
  if (!task.ok) throw new Error("Unexpected dependency cycle");
  const itemId = task.items[0]!.id;
  db.run("UPDATE work_item SET state = 'running' WHERE id = ?", [itemId]);
  const published = publishedPullRequestBody({
    issue: "DEP-686",
    description: "Old",
    evidence: EVIDENCE,
  });
  if (options.pull !== false)
    await recordItemPullRequest(sqliteDb(db), {
      itemId,
      pullNumber: 12,
      pullUrl: null,
      openedAt: 1,
    });
  if (options.pull !== false && options.stored !== false) {
    await savePullRequestText(
      sqliteDb(db),
      itemId,
      {
        title: "Grade release races",
        body: publishedPullRequestBody({
          issue: "DEP-686",
          description: "Old",
          evidence: EVIDENCE,
        }),
        evidence: EVIDENCE,
      },
      1,
    );
  }
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const github: GitHubBinding = {
    appId: "1",
    installationId: "2",
    privateKeyPem: "unused",
    tokenProvider: { mode: "token", tokenFor: async () => "fake-token" },
    client: {
      async request({ method, path, body }) {
        requests.push({ method, path, body });
        if (method === "POST" && path.endsWith("/pulls"))
          return { status: 201, body: { number: 13 } };
        if (method === "GET")
          return {
            status: 200,
            body: {
              number: 12,
              state: options.state ?? "open",
              title: "Grade release races",
              body: published,
            },
          };
        if (options.patch) await options.patch;
        return options.status === 422
          ? { status: 422, body: { message: "Validation Failed" } }
          : { status: 200, body: { number: 12 } };
      },
    },
  };
  const status: string[] = [];
  const journal: string[] = [];
  const controller = new AbortController();
  if (options.stored === false)
    await savePullRequestDraft(
      sqliteDb(db),
      itemId,
      { title: "x", body: options.savedDescription ?? "Old" },
      1,
    );
  if (options.savedDescription)
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId, summary: "## Closeout", head: "474f2d1b" },
      now: 1,
    });
  const apply = async (draft: { title: string; body: string }) => {
    const previous = getPullRequestDraft(db, itemId);
    await savePullRequestDraft(sqliteDb(db), itemId, draft, 2);
    return applyPullRequestDraft({
      store: sqliteDb(db),
      itemId,
      issue: "DEP-686",
      draft,
      previous,
      stopped: async () => controller.signal.aborted,
      signal: controller.signal,
      repository: { owner: "acme", repo: "monorepo" },
      github,
      now: 2,
      status: (line) => status.push(line),
      journal: (line) => journal.push(line),
    });
  };
  return { db, itemId, github, requests, status, journal, apply, controller };
}

const draft = {
  title: "docs(skills): grade release races and broken contracts as P1 [DEP-686]",
  body: "New description",
};

test("a saved title reaches the open pull request without a push", async () => {
  const f = await fixture();
  expect(await f.apply(draft)).toBe("updated");
  expect(f.requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
  const patch = f.requests[1];
  expect(patch!.method).toBe("PATCH");
  expect(patch!.path).toBe("/repos/acme/monorepo/pulls/12");
  const sent = patch!.body as { title: string; body: string };
  expect(sent.title).toBe(draft.title);
  expect(sent.body.startsWith("Fixes DEP-686\n\nNew description\n\n")).toBe(true);
  expect(sent.body).toContain(EVIDENCE);
  expect(await getPullRequestText(sqliteDb(f.db), f.itemId)).toMatchObject({ title: draft.title });
});

test("saving the same title and body again sends nothing", async () => {
  const f = await fixture();
  await f.apply(draft);
  const sent = f.requests.length;
  expect(await f.apply(draft)).toBe("unchanged");
  expect(f.requests).toHaveLength(sent);
});

test("before a pull request exists the draft waits for the pull request to open", async () => {
  const f = await fixture({ pull: false });
  expect(await f.apply(draft)).toBe("no_pull");
  expect(f.requests).toEqual([]);
  await openPullRequest({
    ...f.github,
    issue: "DEP-686",
    owner: "acme",
    repo: "monorepo",
    title: draft.title,
    description: draft.body,
    evidence: EVIDENCE,
  });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.body).toMatchObject({
    title: draft.title,
    body: publishedPullRequestBody({
      issue: "DEP-686",
      description: draft.body,
      evidence: EVIDENCE,
    }),
  });
});

test("a refused update keeps the tool's success and records one status line", async () => {
  const f = await fixture({ status: 422 });
  expect(await f.apply(draft)).toBe("failed");
  expect(f.status).toEqual([
    "Couldn't update the pull request title: GitHub answered 422: Validation Failed",
  ]);
  expect(f.journal).toHaveLength(1);
  expect((await getPullRequestText(sqliteDb(f.db), f.itemId))?.title).toBe("Grade release races");
});

test("a pull request published before Paws stored its text is updated from GitHub's copy", async () => {
  const f = await fixture({ stored: false });
  expect(await f.apply(draft)).toBe("updated");
  expect(f.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "GET /repos/acme/monorepo/pulls/12",
    "PATCH /repos/acme/monorepo/pulls/12",
  ]);
  expect(f.requests[1]!.body).toEqual({
    title: draft.title,
    body: publishedPullRequestBody({
      issue: "DEP-686",
      description: draft.body,
      evidence: EVIDENCE,
    }),
  });
  expect((await getPullRequestText(sqliteDb(f.db), f.itemId))?.evidence).toBe(EVIDENCE);
});

test("stopping the run during the update records nothing", async () => {
  const patch = Promise.withResolvers<void>();
  const f = await fixture({ patch: patch.promise });
  const work = f.apply(draft);
  await Bun.sleep(0);
  f.controller.abort();
  patch.resolve();
  expect(await work).toBe("stopped");
  expect(f.status).toEqual([]);
  expect((await getPullRequestText(sqliteDb(f.db), f.itemId))?.title).toBe("Grade release races");
});

test("a stopped run sends nothing", async () => {
  const f = await fixture();
  f.controller.abort();
  expect(await f.apply(draft)).toBe("stopped");
  expect(f.requests).toEqual([]);
});

test("a pull request closed on GitHub is left alone", async () => {
  const f = await fixture({ state: "closed" });
  expect(await f.apply(draft)).toBe("no_pull");
  expect(f.requests.map((request) => request.method)).toEqual(["GET"]);
});

test("recovery finds the evidence from the Closeout summary when a later draft was never published", async () => {
  const f = await fixture({ stored: false, savedDescription: "Unpublished description" });
  expect(await f.apply(draft)).toBe("updated");
  expect(f.requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
  expect((await getPullRequestText(sqliteDb(f.db), f.itemId))?.evidence).toBe(EVIDENCE);
});
