import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  beginImplementRun,
  bindWorkItemRepository,
  insertQueuedItem,
  recordCiRound,
  recordConfirmedRemoteMerge,
  recordItemBranchState,
  recordItemFiledIssueSteps,
  recordItemPullRequest,
  savePullRequestText,
  type Db,
} from "../../../db";
import { parseIssueDetailResponse, type IssueDetailResponse } from "../contract";
import { openedView } from "../../test/fixtures";
import { render } from "../client/render";
import { parseRoute } from "../client/route";
import { createLiveStatusProvider } from "./provider";
import { seed } from "../../../../test/pglite-fixtures";
import { tempStore } from "../../../../test/pglite";

const NOW = 1_700_000_000_000;
const URL41 = "https://github.com/acme/app/pull/41";
const SHA = "84cf9431a2b3c4d5e6f708192a3b4c5d6e7f8091";
const REPO = { owner: "acme", repo: "app", remoteUrl: "https://github.com/acme/app.git" };
const CHECK = { url: null, startedAt: null, completedAt: null, logTail: null, logSource: null };
const SIZE = { files: 2, additions: 3, deletions: 1 };
const AT = new Date(NOW + 3).toISOString();
const AUTHOR = ["-c", "user.name=t", "-c", "user.email=t@x"];

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-C", cwd, ...AUTHOR, ...args]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

async function store(): Promise<{ db: Db; home: string; base: string; head: string }> {
  const { db, close } = await tempStore();
  const home = mkdtempSync(join(tmpdir(), "paws-pull-facts-"));
  cleanups.push(close, () => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "repos", "acme", "app.git");
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "a.txt"), "one\ntwo\nthree\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "base");
  const base = git(path, "rev-parse", "HEAD");
  writeFileSync(join(path, "a.txt"), "one\n2\nthree\nfour\n");
  writeFileSync(join(path, "b.txt"), "new\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "head");
  return { db, home, base, head: git(path, "rev-parse", "HEAD") };
}

async function withPull(db: Db, id: string, head: string | null, base = ""): Promise<void> {
  await insertQueuedItem(db, { id, title: `Work ${id}`, sessionKey: `s-${id}`, now: NOW });
  await beginImplementRun(db, id, NOW + 1);
  await bindWorkItemRepository(db, id, REPO);
  const published = head ? { published: { head, line: "" } } : {};
  const pull = { itemId: id, pullNumber: 41, pullUrl: URL41, openedAt: NOW + 2 };
  await recordItemPullRequest(db, { ...pull, ...published });
  const branch = { itemId: id, runId: "run", base, commits: 1, recordedAt: NOW };
  if (head && base) await recordItemBranchState(db, { ...branch, head });
}

async function ci(db: Db, itemId: string, head: string, states: string[]): Promise<void> {
  const checks = states.map((state, index) => ({
    ...CHECK,
    name: `test (${index + 1}/${states.length})`,
    state: state as "passed",
  }));
  const round = { runId: null, next: "agent" as const, fix: 1, fixLimit: 3, recordedAt: NOW + 3 };
  await recordCiRound(db, { ...round, itemId, head, checks });
}

async function detail(db: Db, home: string, id: string): Promise<IssueDetailResponse> {
  const options = { now: () => new Date(NOW + 10), env: {}, pawsHome: home };
  const body = JSON.stringify(await createLiveStatusProvider(db, options).issue(id));
  const parsed = parseIssueDetailResponse(JSON.parse(body));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.response;
}

function results(issue: IssueDetailResponse): string {
  const route = parseRoute(`/issues/${issue.issue.id}`);
  const page = { route, phase: "ready" as const, issue, error: null, engineUrl: null };
  const html = render({ ...page, closeout: openedView() }).content.replace(/\s+/g, " ");
  return html.slice(html.indexOf('id="results-heading"'));
}

test.each([
  [
    "open",
    ["passed", "failed", "running"],
    { state: "failed", failed: ["test (2/3)"] },
    "CI failed: test (2/3)",
  ],
  ["merged", ["passed", "passed"], { state: "passed", failed: [] }, "CI passed"],
  ["closed", ["passed", "running"], { state: "pending", failed: [] }, "CI running"],
] as const)(
  "a %s pull request shows its own state, CI and size",
  async (state, checks, expected, line) => {
    const { db, home, base, head } = await store();
    await withPull(db, "ENG-1", head, base);
    await savePullRequestText(db, "ENG-1", { title: "Cache it", body: "", evidence: "" }, NOW);
    await ci(db, "ENG-1", "0".repeat(40), ["failed"]);
    await ci(db, "ENG-1", head, [...checks]);
    const merge = {
      repositoryOwner: "acme",
      repositoryName: "app",
      pullNumber: 41,
      pullUrl: URL41,
    };
    if (state === "merged")
      await recordConfirmedRemoteMerge(db, {
        ...merge,
        itemId: "ENG-1",
        mergeSha: SHA,
        confirmedAt: NOW + 4,
      });
    if (state === "closed")
      await seed(db, (q) =>
        q.orm.update(q.t.workItem).set({ state: "cancelled" }).where(eq(q.t.workItem.id, "ENG-1")),
      );
    const issue = await detail(db, home, "ENG-1");
    expect(issue.issue.pr).toEqual({
      number: 41,
      url: URL41,
      title: "Cache it",
      state,
      openedAt: new Date(NOW + 2).toISOString(),
      head,
      ...(state === "merged" ? { mergeSha: SHA, mergedAt: new Date(NOW + 4).toISOString() } : {}),
      ci: { ...expected, failed: [...expected.failed], at: AT },
      size: SIZE,
    });
    const html = results(issue);
    expect(html).toContain('<span class="lin-id">#41</span> Cache it</a>');
    expect(html).toContain(`class="st ${state}"`);
    expect(html).toContain(line);
    expect(html).toContain("+3 −1 in 2 files");
    expect(html.includes(`Merged as <a href="https://github.com/acme/app/commit/${SHA}"`)).toBe(
      state === "merged",
    );
  },
);

test("missing text, CI, branch and mirror leave those fields out", async () => {
  const { db, home } = await store();
  await withPull(db, "ENG-4", null);
  const bare = await detail(db, home, "ENG-4");
  const openedAt = new Date(NOW + 2).toISOString();
  expect(bare.issue.pr).toEqual({ number: 41, url: URL41, state: "open", openedAt });
  const html = results(bare);
  expect(html).toContain('<span class="lin-id">#41</span> Work ENG-4</a>');
  expect(html).not.toContain("data-result-size");
  await withPull(db, "ENG-5", "a".repeat(40), "b".repeat(40));
  const lost = (await detail(db, home, "ENG-5")).issue.pr;
  expect(lost).toEqual({ number: 41, url: URL41, state: "open", openedAt, head: "a".repeat(40) });
});

test("a follow-up's pull request shows its own state and CI", async () => {
  const { db, home, base, head } = await store();
  await insertQueuedItem(db, { id: "ENG-6", title: "Origin", sessionKey: "s-6", now: NOW });
  await withPull(db, "ENG-7", head, base);
  await ci(db, "ENG-7", head, ["failed"]);
  const filed = { itemId: "ENG-6", runId: "run", url: null, started: true, filedAt: NOW + 1 };
  const issue = { linearIssueId: "lin-item-ENG-7", identifier: "ENG-7", title: "Fix the cache" };
  await db.run((q) => recordItemFiledIssueSteps(q, { ...filed, ...issue }));
  const origin = await detail(db, home, "ENG-6");
  expect(origin.followUps[0]!.pull).toEqual({
    number: 41,
    url: URL41,
    state: "open",
    ci: { state: "failed", failed: ["test (1/1)"], at: AT },
    size: SIZE,
  });
  const row = results(origin).match(/<li[^>]*data-follow-up>.*?<\/li>/)![0];
  expect(row).toContain('<span class="lin-id">#41</span>');
  expect(row).toContain('class="st open"');
  expect(row).toContain("CI failed: test (1/1)");
});
