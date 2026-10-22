import { describe, expect, test } from "bun:test";
import {
  parseStatusSnapshot,
  statusIntegrity,
  type StatusItem,
  type StatusMergeEntry,
  type StatusMergeSettings,
  type StatusSnapshot,
} from "../contract";
import { demoStatus } from "../demo";
import { mergeQueueCount } from "./merge-queue";
import { render } from "./render";
import { matchRoute, routePath } from "./route";
import { NAVIGATION } from "./navigation";

const NOW = "2026-10-22T12:00:00.000Z";
const QUEUE: StatusMergeSettings = { order: "queue", mainMoved: "ci", rule: null };
const GREEN: StatusMergeSettings = { order: "ci-green", mainMoved: "ci", rule: null };

function item(id: string, title: string, repository: string, pr: number): StatusItem {
  return {
    id,
    title,
    state: "merge_queue",
    agent: "Claude",
    assignee: "Unassigned",
    owner: "Aisha Khan",
    project: { id: "audit", name: "Audit log export" },
    blockers: [],
    attempts: 1,
    branch: `paws/${id}`,
    runId: null,
    pr: { number: pr, url: `https://github.com/${repository}/pull/${pr}` },
    links: [],
  };
}

function entry(
  itemId: string,
  repository: string,
  position: number | null,
  waitingFor: StatusMergeEntry["waitingFor"],
  minutesAgo: number,
  settings: StatusMergeSettings = QUEUE,
  detail: string | null = null,
): StatusMergeEntry {
  const at = new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
  return {
    position,
    itemId,
    repository,
    enqueuedAt: at,
    acceptedAt: at,
    waitingFor,
    detail,
    settings,
    steps: [],
  };
}

/** acme/platform queues three issues; acme/web merges each when green. */
function twoRepositories(): StatusSnapshot {
  const snapshot = demoStatus();
  snapshot.generatedAt = NOW;
  snapshot.items = [
    item("ENG-101", "Audit log model", "acme/platform", 412),
    item("ENG-102", "CSV / JSON formatters", "acme/platform", 415),
    item("ENG-107", "Fix export timezone", "acme/platform", 418),
    item("ENG-120", "Landing copy", "acme/web", 31),
    item("ENG-121", "Footer links", "acme/web", 32),
    { ...item("ENG-130", "Retention job", "acme/platform", 420), state: "running" },
    { ...item("ENG-99", "Export button", "acme/platform", 405), state: "merged" },
  ];
  snapshot.runs = [];
  snapshot.questions = [];
  snapshot.verdicts = [];
  snapshot.evidence = [];
  snapshot.agentCloseout = [];
  snapshot.mergeQueue = [
    entry(
      "ENG-101",
      "acme/platform",
      1,
      "ci",
      50,
      QUEUE,
      "Branch updated onto main 9f1c2ab. CI 4 of 6 checks done.",
    ),
    entry("ENG-102", "acme/platform", 2, "ahead", 35, QUEUE, "Starts when #412 merges"),
    entry(
      "ENG-107",
      "acme/platform",
      3,
      "ahead",
      10,
      { order: "queue", mainMoved: "closeout", rule: "Bug" },
      "Starts when #415 merges",
    ),
    entry("ENG-120", "acme/web", null, "ci", 5, GREEN),
    entry("ENG-121", "acme/web", null, "review", 125, GREEN),
  ];
  snapshot.mergeHistory = [
    {
      itemId: "ENG-99",
      repository: "acme/platform",
      outcome: "merged",
      reason: null,
      at: "2026-10-22T10:00:00.000Z",
      settings: QUEUE,
    },
    {
      itemId: "ENG-130",
      repository: "acme/platform",
      outcome: "back_with_agent",
      reason: "conflict",
      at: "2026-10-22T11:30:00.000Z",
      settings: QUEUE,
    },
  ];
  return snapshot;
}

function page(snapshot: StatusSnapshot): string {
  return render({
    route: { view: "mergeQueue" },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
  }).content;
}

/** The text of one table row, tags stripped. */
function rowText(html: string, itemId: string): string {
  const row = new RegExp(`<tr data-merge-item="${itemId}">(.*?)</tr>`).exec(html)?.[1] ?? "";
  return row
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("merge queue page", () => {
  test("is a Work page at /merge-queue with a count badge of the waiting tasks", () => {
    expect(NAVIGATION[0].views).toContain("mergeQueue");
    expect(routePath({ view: "mergeQueue" })).toBe("/merge-queue");
    expect(matchRoute("/merge-queue")).toEqual({ view: "mergeQueue" });
    expect(mergeQueueCount(twoRepositories())).toBe(5);
    expect(mergeQueueCount(null)).toBe(0);
  });

  test("two repositories: three queued issues in order, and one repository without the queue", () => {
    const snapshot = twoRepositories();
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    const html = page(parsed.snapshot);
    expect(html).toContain('<h1 class="sr-only">Merge queue</h1>');
    const platform = html.indexOf(">acme/platform</h2>");
    const web = html.indexOf(">acme/web</h2>");
    expect(platform).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(platform);
    const queued = html.slice(platform, web);
    expect(queued).toContain("Merge queue on");
    expect(queued).toContain("Re-check: CI only");
    expect(queued.indexOf("ENG-101")).toBeLessThan(queued.indexOf("ENG-102"));
    expect(queued.indexOf("ENG-102")).toBeLessThan(queued.indexOf("ENG-107"));
    expect(rowText(html, "ENG-101")).toBe(
      "1 ENG-101 Audit log model Audit log export Aisha Khan #412 50m Waiting for CI Branch updated onto main 9f1c2ab. CI 4 of 6 checks done",
    );
    expect(rowText(html, "ENG-102")).toBe(
      "2 ENG-102 CSV / JSON formatters Audit log export Aisha Khan #415 35m Queued Starts when #412 merges",
    );
    expect(rowText(html, "ENG-107")).toContain(
      "3 ENG-107 Fix export timezone Audit log export Aisha Khan #418 10m Queued Starts when #415 merges · Bug rule: runs Closeout again after its branch update",
    );
    const green = html.slice(web);
    expect(green).toContain("Merge each when green");
    expect(green).toContain("each pull request merges when green");
    expect(green).not.toContain('<th class="run-cell">#</th>');
    expect(rowText(html, "ENG-120")).toStartWith("ENG-120 Landing copy");
    expect(html).toContain('href="https://github.com/acme/web/pull/31"');
  });

  test("an issue waiting on review approval holds no place and says why", () => {
    const html = page(twoRepositories());
    expect(rowText(html, "ENG-121")).toBe(
      "ENG-121 Footer links Audit log export Aisha Khan #32 2h 5m Waiting for review Waiting for an approving review on #32. It merges once approved and green",
    );
    const queued = twoRepositories();
    queued.mergeQueue[0] = entry("ENG-101", "acme/platform", null, "review", 3);
    expect(rowText(page(queued), "ENG-101")).toStartWith("– ENG-101");
  });

  test("an issue back with the agent, and the pull requests merged today", () => {
    const html = page(twoRepositories());
    const done = html.slice(html.indexOf("<h3>Done and stopped</h3>"));
    expect(html.indexOf("<h3>Done and stopped</h3>")).toBeLessThan(html.indexOf(">acme/web</h2>"));
    expect(done.indexOf("ENG-130")).toBeLessThan(done.indexOf("ENG-99"));
    expect(done).toContain('<span class="st warn">Back with the agent</span>');
    expect(done).toContain("The branch update conflicted 30m ago.");
    expect(done).toContain('<span class="st merged">Merged</span>');
    expect(done).toContain("Merged 2h ago.");
    expect(done).toContain('aria-label="Pull request 405"');
  });

  test("a repository with only finished work shows no table", () => {
    const snapshot = twoRepositories();
    snapshot.mergeQueue = snapshot.mergeQueue.filter(
      (waiting) => waiting.repository === "acme/web",
    );
    const html = page(snapshot);
    const platform = html.slice(
      html.indexOf(">acme/platform</h2>"),
      html.indexOf(">acme/web</h2>"),
    );
    expect(platform).toContain("No pull requests waiting.");
    expect(platform).not.toContain("<table");
  });

  test("the empty state", () => {
    const snapshot = twoRepositories();
    snapshot.mergeQueue = [];
    snapshot.mergeHistory = [];
    expect(page(snapshot)).toContain("Nothing is waiting to merge.");
    expect(mergeQueueCount(snapshot)).toBe(0);
  });

  test("detail columns hide on phones", () => {
    const html = page(twoRepositories());
    for (const heading of ["Project", "Delegated by", "Waiting", "Detail"])
      expect(html).toContain(`<th class="run-cell hide-phone">${heading}</th>`);
    for (const heading of ["#", "Issue", "PR", "Step"])
      expect(html).toContain(`<th class="run-cell">${heading}</th>`);
  });
});
