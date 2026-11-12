import { openedView, fullStatusFixture, pageData, type FullStatus } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { issueRowMatches, NO_PROJECT_FILTER, render, type RenderModel } from "./render";
import { parseRoute } from "./route";
import { checkKey } from "./closeout";
import { clock24, esc } from "./format";

/** `snapshot` is the full fixture; the model gets its list and, on an issue page, its detail. */
function model(
  patch: Omit<Partial<RenderModel>, "snapshot"> & { snapshot?: FullStatus | null } = {},
): RenderModel {
  const { snapshot = fullStatusFixture(), route = { view: "overview" }, ...rest } = patch;
  return {
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout: openedView(),
    ...rest,
    ...(snapshot === null ? { route, snapshot: null } : pageData(snapshot, route)),
  };
}

/** The overview's tile values in order: In flight, Awaiting input, Merge queue, Queued. */
function tiles(html: string): number[] {
  return [...html.matchAll(/data-stat-value>(\d+)</g)].map((match) => Number(match[1]));
}

/** Issue ids of the overview's items table, top to bottom. */
function tableIds(html: string): string[] {
  return [...html.matchAll(/<tr data-issue-id="([^"]+)"/g)].map((match) => match[1]!);
}

function tableRow(html: string, id: string): string {
  return html.slice(html.indexOf(`data-issue-id="${id}"`)).split("</tr>")[0]!;
}

describe("status views", () => {
  test("overview follows only the current run after recovery and lists queued work", () => {
    const snapshot = fullStatusFixture();
    const run = snapshot.runs[0];
    const item = snapshot.items.find((entry) => entry.id === run?.itemId);
    if (!run || !item) throw new Error("missing fixture");
    item.state = "running";
    item.runId = "current-run";
    item.blockers = [];
    snapshot.items = [item];
    snapshot.runs = [
      { ...run, id: "old-run", state: "done" },
      { ...run, id: "current-run", state: "running" },
    ];
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.mergeQueue = [];
    const running = render(model({ snapshot })).content;
    expect(running).toContain(`href="/issues/${item.id}"`);
    expect(running).not.toContain('href="/runs/');
    expect(tableRow(running, item.id)).toContain('<span class="st running">running</span>');
    expect(tiles(running)).toEqual([1, 0, 0, 0]);
    item.state = "queued";
    item.runId = null;
    const queued = render(model({ snapshot })).content;
    expect(tiles(queued)).toEqual([0, 0, 0, 1]);
    expect(queued).toContain("Waiting for a free runner");
    expect(queued).toContain('href="/issues"');
    expect(queued).not.toContain('href="/runs/old-run"');
    expect(queued).not.toContain('href="/runs/current-run"');
  });

  test("terminal closeout outcomes override a stale verifying run in both views", () => {
    for (const [decision, detail] of [
      ["blocked", "Closeout blocked"],
      ["exhausted", "Closeout exhausted"],
    ] as const) {
      const snapshot = fullStatusFixture();
      const verdict = snapshot.verdicts[0];
      const item = snapshot.items.find((entry) => entry.id === verdict?.itemId);
      const run = snapshot.runs.find((entry) => entry.itemId === item?.id);
      if (!verdict || !item || !run) throw new Error("missing fixture");
      verdict.decision = decision;
      item.state = "awaiting_input";
      run.state = "verifying";
      const html = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
      expect(html).toContain("<h2>Closeout</h2>");
      expect(html).toContain(detail);
      expect(html).not.toContain("Closeout is verifying this candidate.");
    }
  });
  test("artifact links use the selected engine and wait for completed checks", () => {
    const snapshot = fullStatusFixture();
    const verdict = snapshot.verdicts[0];
    const check = verdict?.checks[0];
    const run = snapshot.runs.find((entry) => entry.itemId === verdict?.itemId);
    if (!verdict || !check || !run) throw new Error("missing verdict");
    check.logPath = "logs/check/1.log";
    check.evidencePath = "evidence/check/1.json";
    check.stdout = "Live output\n";
    const input = () =>
      model({
        snapshot,
        engineUrl: "https://engine.example/api/status",
        route: { view: "runs", id: run.id },
        closeout: openedView({ [checkKey(verdict.itemId, 1, check.id)]: true }),
      });
    expect(render(input()).content).toContain(
      'href="https://engine.example/api/closeout-artifact?',
    );
    check.state = "running";
    check.active = true;
    const live = render(input()).content;
    expect(live).not.toContain("/api/closeout-artifact?");
    expect(live).toContain("Download output");
  });

  test("overview leads with actions, then every open issue by phase, instead of delivery and raw events", () => {
    const view = render(model());
    expect(view.top).not.toContain("Demo data");
    expect(view.top).not.toContain("Refresh");
    expect(view.banner).toBe("");
    expect(view.content).toContain('Needs you <span class="cnt">2</span>');
    expect(tableIds(view.content)).toEqual(["ENG-102", "ENG-103", "ENG-100", "ENG-101", "ENG-104"]);
    expect(tiles(view.content)).toEqual([1, 2, 1, 1]);
    expect(view.content).toContain('href="/questions/Q-41"');
    expect(view.content).toContain("Answer question");
    expect(view.content).toContain("Closeout requirement unit exhausted (3/3)");
    expect(view.content).toContain('href="/issues/ENG-102"');
    expect(view.content).toContain('href="/issues/ENG-101"');
    expect(view.content).toContain("Blocked by ENG-101, ENG-102, ENG-103");
    expect(view.content).toContain("All issues");
    expect(view.content).not.toContain("Delivery");
    expect(view.content).not.toContain("Recent events");
    expect(view.content).not.toContain('href="/queue"');
    expect(view.content).not.toContain("/epics");
    expect(view.content).not.toContain("javascript:");
    expect(view.content.match(/Signed URL delivery/g)).toHaveLength(2);
    expect(view.content.match(/Retention policy enforcement job/g)).toHaveLength(2);
  });

  test("overview tiles count open work and the items table lists it active first, then queued", () => {
    const snapshot = fullStatusFixture();
    snapshot.questions = [];
    snapshot.verdicts = [];
    const at = (minutes: number) =>
      new Date(Date.parse(snapshot.generatedAt) - minutes * 60_000).toISOString();
    const byId = (id: string) => snapshot.items.find((entry) => entry.id === id)!;
    const extra = (id: string, state: FullStatus["items"][number]["state"]) => ({
      ...byId("ENG-102"),
      id,
      title: `Extra ${id}`,
      state,
      runId: null,
    });
    byId("ENG-101").state = "verifying";
    byId("ENG-100").state = "queued";
    byId("ENG-104").held = { reason: "blocked", blockers: ["ENG-103"] };
    snapshot.items.splice(0, 0, extra("ENG-110", "queued"));
    snapshot.items.push(extra("ENG-111", "running"));
    snapshot.mergeQueue = snapshot.mergeQueue.slice(0, 1);
    const fixing = byId("ENG-102");
    fixing.doing = { kind: "running", runners: ["agentbox"], since: at(8), stalled: false };
    fixing.activeMs = 74 * 60_000;
    const html = render(model({ snapshot })).content;
    expect(tiles(html)).toEqual([3, 1, 1, 3]);
    snapshot.items = snapshot.items.filter((item) => item.id !== "ENG-104");
    const view = render(model({ snapshot })).content;
    expect(tiles(view)).toEqual([3, 1, 1, 2]);
    expect(tableIds(view)).toEqual([
      "ENG-102",
      "ENG-111",
      "ENG-101",
      "ENG-103",
      "ENG-110",
      "ENG-100",
    ]);
    expect(tableRow(view, "ENG-102")).toContain("Running on agentbox · 1.2 h active");
    expect(tableRow(view, "ENG-102")).toContain('href="/issues/ENG-102"');
    expect(tableRow(view, "ENG-103")).toContain(
      '<span class="st awaiting_input">awaiting_input</span>',
    );
    expect(tableRow(view, "ENG-110")).toContain("Waiting for a free runner");
    expect(tableIds(view)).not.toContain("ENG-99");
    expect(view.slice(view.indexOf("merged-heading"))).toContain("Audit event schema v2");
    expect(html).toContain("In flight");
    expect(html).toContain("1 held");
  });

  test("a lifecycle entry reads `event → state` with its time and reason", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-102")!;
    item.timeline = [
      {
        at: "2026-10-09T20:58:00.000Z",
        kind: "restart",
        from: "verifying",
        to: "queued",
        event: "restart",
        reason: "findings",
        actor: "Ada",
      },
    ];
    const page = render(
      model({
        snapshot,
        route: { view: "issues", id: "ENG-102" },
        closeout: openedView({ "section\ndetails:ENG-102": true }),
      }),
    ).content;
    const entry = page.slice(page.indexOf('<li data-kind="restart">'));
    expect(entry).toContain('<span class="timeline-dot" data-state="queued" aria-hidden="true">');
    expect(entry).toContain(
      '<p class="timeline-move font-mono text-xs">restart <span class="text-muted-foreground"><span aria-hidden="true">→</span><span class="sr-only">to</span> queued</span></p>',
    );
    expect(entry).toContain(
      `>${clock24("2026-10-09T20:58:00.000Z")}</time> · Back to the agent for Closeout findings. · by Ada</p>`,
    );
  });

  test("the issue page splits the time line by stage", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-102")!;
    item.doing = { kind: "running", runners: ["agentbox"], since: null, stalled: false };
    item.activeMs = 217 * 60_000;
    item.stageTimes = {
      implementation: { ms: 130 * 60_000, limitMs: 180 * 60_000 },
      fixes: { ms: 65 * 60_000, limitMs: 0 },
      closeout: { ms: 0, limitMs: 0 },
    };
    const page = render(model({ snapshot, route: { view: "issues", id: "ENG-102" } })).content;
    expect(page).toContain(
      '<span class="muted" data-item-now>Implementation 2 h 10 m of 3 h · Fixes 1 h 05 m (not counted)</span>',
    );
    expect(render(model({ snapshot })).content).toContain("3.6 h active");
  });

  test("runner work still preparing shows Preparing on Overview, Issues and the issue page", () => {
    const snapshot = fullStatusFixture();
    snapshot.questions = [];
    snapshot.verdicts = [];
    const item = snapshot.items.find((entry) => entry.id === "ENG-102")!;
    item.timeline = [];
    item.activeMs = 3 * 60_000;
    const label = "Preparing: checking out and installing runtimes on agentbox";
    const views = () => {
      const overview = render(model({ snapshot })).content;
      return {
        overview: tableRow(overview, "ENG-102"),
        issues: issueRow(
          render(model({ snapshot, route: { view: "issues", id: null } })).content,
          "ENG-102",
        ),
        page: render(model({ snapshot, route: { view: "issues", id: "ENG-102" } })).content,
      };
    };
    item.doing = { kind: "running", runners: ["agentbox"], since: null, phase: "preparing" };
    const preparing = views();
    expect(preparing.overview).toContain(label);
    expect(preparing.issues).toContain(label);
    expect(preparing.page).toContain(`Implementing · ${label}`);
    item.doing = { ...item.doing, phase: "agent" };
    const agent = views();
    for (const html of Object.values(agent)) expect(html).not.toContain("Preparing");
    expect(agent.overview).toContain("Running on agentbox · 3 min active");
    expect(agent.issues).toContain("Running on agentbox");
  });

  test("overview includes input holds without a question and paused work under Needs you", () => {
    const snapshot = fullStatusFixture();
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.items[0]!.state = "awaiting_input";
    const html = render(model({ snapshot })).content;
    expect(html).toContain("Review issue");
    expect(html).toContain("Waiting for your input.");
    expect(html).not.toContain('href="/runs/r-102"');
    snapshot.runs[0]!.state = "paused";
    const paused = render(model({ snapshot })).content;
    expect(paused).toContain("This issue is paused.");
    expect(paused.match(/data-item="ENG-102"/g)).toHaveLength(1);
    expect(tableIds(paused)).toContain("ENG-102");
  });

  test("overview lists a verdict as needing a person only while the item is stopped on it", () => {
    const snapshot = fullStatusFixture();
    snapshot.questions = [];
    const verdict = snapshot.verdicts[0];
    const item = snapshot.items.find((entry) => entry.id === verdict?.itemId);
    const run = snapshot.runs.find((entry) => entry.id === item?.runId);
    if (!item || !run || !verdict) throw new Error("missing fixture");
    snapshot.items = [item];
    snapshot.mergeQueue = [];
    item.blockers = [];
    item.state = "verifying";
    run.state = "verifying";
    verdict.decision = "exhausted";
    const verifying = render(model({ snapshot })).content;
    expect(verifying).toContain('Needs you <span class="cnt">0</span>');
    expect(tiles(verifying)).toEqual([1, 0, 0, 0]);
    expect(verifying).not.toContain("Automatic retries are used up.");
    item.state = "awaiting_input";
    run.state = "awaiting_input";
    expect(render(model({ snapshot })).content).toContain("Automatic retries are used up.");
    item.state = "needs_human";
    run.state = "stopped";
    verdict.decision = "blocked";
    expect(render(model({ snapshot })).content).toContain("Work is blocked and needs a person.");
  });

  test("overview keeps finished work out of the active lists and shows it as recently merged", () => {
    const snapshot = fullStatusFixture();
    snapshot.questions = [];
    snapshot.items = snapshot.items.filter((item) => item.state === "merged");
    const html = render(model({ snapshot })).content;
    expect(tiles(html)).toEqual([0, 0, 1, 0]);
    expect(tableIds(html)).toEqual([]);
    expect(html).toContain("Nothing needs your attention.");
    expect(html).toContain("No open work right now.");
    const merged = html.slice(html.indexOf("merged-heading"));
    expect(merged).toContain("Audit event schema v2");
    expect(merged).toContain("PR #474");
  });

  test("overview keeps questions reachable with no items and gives new work a useful empty state", () => {
    const snapshot = fullStatusFixture();
    snapshot.items = [];
    const html = render(model({ snapshot })).content;
    expect(html).toContain('href="/questions/Q-41"');
    snapshot.questions = [];
    expect(render(model({ snapshot })).content).toContain("Delegate an issue to Paws in Linear.");
  });

  test("overview shows the setup checklist until every step is done", () => {
    const snapshot = fullStatusFixture();
    snapshot.items = [];
    snapshot.questions = [];
    const first = model({ snapshot });
    first.overview!.setup = { github: true, runner: false, agent: false, delegated: false };
    const html = render(first).content;
    const steps = [...html.matchAll(/data-setup-step="(\w+)"/g)].map((match) => match[1]);
    expect(steps).toEqual(["done", "done", "next", "todo", "todo"]);
    expect(html).toContain("Set up Paws");
    expect(html).toContain('href="/runners"');
    expect(html).not.toContain('href="/settings/integrations"');
    expect(html).toContain(
      "Questions, the merge queue and findings fill as work moves through Paws.",
    );
    const done = model({ snapshot });
    done.overview!.setup = { github: true, runner: true, agent: true, delegated: true };
    expect(render(done).content).not.toContain("data-setup-checklist");
  });

  test("overview lists every active issue with no cap", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items[2]!;
    snapshot.items = Array.from({ length: 9 }, (_, index) => ({
      ...item,
      id: `WORK-${index}`,
      title: `Item ${index}`,
      runId: null,
      blockers: [],
    }));
    snapshot.questions = [];
    snapshot.verdicts = [];
    const html = render(model({ snapshot })).content;
    expect(tableIds(html)).toHaveLength(9);
    expect(html).toContain("Item 8");
    expect(html).not.toContain("View all");
  });

  test("issue filters keep in-progress work out of Done", () => {
    const snapshot = fullStatusFixture();
    const html = render(model({ snapshot, route: { view: "issues", id: null } })).content;
    expect(issueRow(html, "ENG-102")).toContain('data-issue-state="active"');
    expect(issueRow(html, "ENG-100")).toContain('data-issue-state="needs"');
    expect(issueRow(html, "ENG-99")).toContain('data-issue-state="done"');
    const open = snapshot.items.find((item) => item.id === "ENG-99");
    if (!open) throw new Error("missing item");
    open.state = "running";
    const active = render(model({ snapshot, route: { view: "issues", id: null } })).content;
    expect(issueRow(active, "ENG-99")).toContain('data-issue-state="active"');
    expect(issueRow(active, "ENG-99")).not.toContain('data-issue-state="done"');
  });

  test("issues list shows the project and unmerged blockers", () => {
    const html = render(model({ route: { view: "issues", id: null } })).content;
    const blocked = issueRow(html, "ENG-104");
    expect(blocked).toContain("Audit log export");
    expect(blocked).toContain("Blocked by ENG-101, ENG-102, ENG-103");
    const solo = issueRow(html, "ENG-102");
    expect(solo).not.toContain("Audit log export");
    expect(solo).not.toContain("Blocked by");
    const detail = render(model({ route: { view: "issues", id: "ENG-101" } })).content;
    expect(detail).toContain("Jonas Berg");
    expect(detail).toContain("Audit log export");
    expect(detail).toContain('id="activity-heading">Timeline</h2>');
    expect(detail).toContain("PR #479");
    expect(detail).not.toContain('href="/issues/ENG-99"');
    expect(detail).toContain('href="/issues/ENG-104"');
  });

  test("the issues list is one table row per issue with blockers under the title", () => {
    const snapshot = fullStatusFixture();
    snapshot.items = snapshot.items.filter((item) =>
      ["ENG-101", "ENG-102", "ENG-104"].includes(item.id),
    );
    snapshot.items.find((item) => item.id === "ENG-104")!.blockers = ["ENG-101", "ENG-102"];
    const html = render(model({ snapshot, route: { view: "issues", id: null } })).content;
    expect(html).toContain('<table class="run-table issues-table">');
    const rows = [...html.matchAll(/<tr class="issue-row"[^>]*data-issue-id="([^"]+)"[^>]*>/g)];
    expect(rows.map((row) => row[1]).sort()).toEqual(["ENG-101", "ENG-102", "ENG-104"]);
    const title = issueRow(html, "ENG-104").split("<td>")[2]!;
    expect(title).toContain('<div class="text-xs text-muted-foreground" data-blockers>');
    expect(title).toContain('href="/issues/ENG-101">ENG-101</a>');
    expect(title).toContain('href="/issues/ENG-102">ENG-102</a>');
    expect(issueRow(html, "ENG-102").split("<td>")[2]).not.toContain("data-blockers");
    const filtered = rows.filter((row) =>
      issueRowMatches(
        {
          state: /data-issue-state="([^"]+)"/.exec(row[0])?.[1],
          project: /data-issue-project="([^"]+)"/.exec(row[0])?.[1],
        },
        { state: "all", project: NO_PROJECT_FILTER },
      ),
    );
    expect(filtered.map((row) => row[1]).sort()).toEqual(
      snapshot.items
        .filter((item) => !item.project)
        .map((item) => item.id)
        .sort(),
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(rows.length);
  });

  test("a queued item shows its place in line on the run and issue pages", () => {
    const snapshot = fullStatusFixture();
    const run = snapshot.runs.find((entry) => entry.id === "r-102");
    const item = snapshot.items.find((entry) => entry.id === run?.itemId);
    if (!run || !item) throw new Error("missing fixture");
    item.state = "queued";
    const before = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
    expect(before).not.toContain("in line");
    item.queue = { position: 2, busySlots: 4, totalSlots: 4 };
    const page = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
    expect(page).toContain("Queued, 2nd in line. 4 of 4 runner slots are busy.");
    expect(page).toContain('<span class="result-icon" aria-hidden="true">2</span>');
    expect(page).toContain(`Paws starts ${item.id} when a slot frees.`);
    expect(page).toContain('<span class="st queued">queued</span>');
    item.queue = { position: 11, busySlots: 1, totalSlots: 1 };
    const issue = render(model({ snapshot, route: { view: "issues", id: item.id } })).content;
    expect(issue).toContain("Queued, 11th in line. 1 of 1 runner slot is busy.");
    item.state = "running";
    expect(render(model({ snapshot, route: { view: "runs", id: run.id } })).content).not.toContain(
      "in line",
    );
  });

  test("a held item shows why it waits on its issue page", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items[0]!;
    item.state = "queued";
    item.blockers = [];
    delete item.queue;
    const issue = () => render(model({ snapshot, route: { view: "issues", id: item.id } })).content;
    expect(issue()).not.toContain("Waiting:");
    const lines: [NonNullable<typeof item.held>, string][] = [
      [{ reason: "blocked", blockers: ["PAS-367"] }, "Waiting: blocked by PAS-367"],
      [{ reason: "blocked", blockers: [] }, "Waiting: blocked by another issue"],
      [{ reason: "project", blockers: [] }, "Waiting: its project has not released it yet"],
      [{ reason: "reconciling", blockers: [] }, "Waiting: Linear changes are still syncing"],
      [{ reason: "snapshot", blockers: [] }, "Waiting: reading its dependencies from Linear"],
      [{ reason: "cap", blockers: [] }, "Waiting: its owner already runs the most items at once"],
      [{ reason: "slot", blockers: [] }, "Waiting: no free slot on any runner"],
      [{ reason: "workspace", blockers: [] }, "Waiting: no Linear workspace is configured"],
      [
        { reason: "overlap", blockers: ["PAS-785"], files: ["src/dashboard/src/live/provider.ts"] },
        "Held: waiting for PAS-785 to merge (both change provider.ts)",
      ],
    ];
    for (const [held, line] of lines) {
      item.held = held;
      expect(issue()).toContain(line);
    }
    item.held = { reason: "workspace", blockers: [] };
    expect(render(model({ snapshot, route: { view: "issues", id: null } })).content).toContain(
      '<span class="muted" data-wait-reason>Waiting: no Linear workspace is configured</span>',
    );
    item.held = { reason: "slot", blockers: [] };
    item.queue = { position: 2, busySlots: 4, totalSlots: 4 };
    expect(issue()).toContain("Queued, 2nd in line. 4 of 4 runner slots are busy.");
    expect(issue()).toContain("Waiting: no free slot on any runner.");
    item.state = "running";
    expect(issue()).not.toContain("Waiting:");
  });

  test("a blocked item shows when its blockers were last checked and a check button", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items[0]!;
    item.state = "queued";
    delete item.queue;
    const issue = () => render(model({ snapshot, route: { view: "issues", id: item.id } })).content;
    item.held = { reason: "blocked", blockers: ["ACME-12"] };
    expect(issue()).toContain("Blockers not checked yet; checked every minute while blocked");
    item.held.checkedAt = new Date(Date.parse(snapshot.generatedAt) - 2 * 60_000).toISOString();
    expect(issue()).toContain("Blockers last checked 2m ago; checked every minute while blocked");
    expect(issue()).toContain(
      `data-check-blockers="${item.id}" hidden>Check blockers now</button>`,
    );
    item.held = { reason: "slot", blockers: [] };
    expect(issue()).not.toContain("Check blockers now");
  });

  test("the issue page shows how many Linear requests the item made", () => {
    const snapshot = fullStatusFixture();
    const run = snapshot.runs.find((entry) => entry.id === "r-102");
    const item = snapshot.items.find((entry) => entry.id === run?.itemId);
    if (!run || !item) throw new Error("missing fixture");
    item.linearRequests = 12;
    const closeout = openedView();
    closeout.open[`section\ndetails:${item.id}`] = true;
    const page = render(model({ snapshot, route: { view: "runs", id: run.id }, closeout })).content;
    expect(page).toContain("<dt>Linear requests</dt><dd>12</dd>");
  });

  test("an item in the merge queue shows its place on the run and issue pages", () => {
    const snapshot = fullStatusFixture();
    const run = snapshot.runs.find((entry) => entry.id === "r-102");
    const item = snapshot.items.find((entry) => entry.id === run?.itemId);
    if (!run || !item) throw new Error("missing fixture");
    item.state = "merge_queue";
    const before = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
    expect(before).not.toContain("queue</h3>");
    item.mergeQueue = { repository: "acme/platform", position: 2, total: 3, ahead: "ENG-101" };
    const page = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
    expect(page).toContain("Second in the acme/platform queue");
    expect(page).toContain("Waiting to merge · #2 in queue");
    expect(page).toContain("ENG-101 merges first.");
    item.mergeQueue = { repository: "acme/platform", position: 1, total: 1, ahead: null };
    const issue = render(model({ snapshot, route: { view: "issues", id: item.id } })).content;
    expect(issue).toContain("First in the acme/platform queue");
    expect(issue).toContain("This pull request moves now");
    item.state = "verifying";
    item.mergeQueue = {
      repository: "acme/platform",
      position: 1,
      total: 3,
      ahead: null,
      rechecking: true,
    };
    const rechecking = render(model({ snapshot, route: { view: "issues", id: item.id } })).content;
    expect(rechecking).toContain("Re-checking, keeps its place.");
    expect(rechecking).not.toContain("Not in the merge queue yet.");
    item.state = "merge_queue";
    item.mergeQueue = { repository: "acme/platform", position: 2, total: 3, ahead: null };
    expect(render(model({ snapshot, route: { view: "issues", id: item.id } })).content).toContain(
      "This pull request moves now",
    );
    item.state = "running";
    expect(render(model({ snapshot, route: { view: "runs", id: run.id } })).content).not.toContain(
      "acme/platform queue",
    );
  });

  test("an item in the GitHub merge queue shows GitHub's position and state", () => {
    const snapshot = fullStatusFixture();
    const run = snapshot.runs.find((entry) => entry.id === "r-102");
    const item = snapshot.items.find((entry) => entry.id === run?.itemId);
    if (!run || !item) throw new Error("missing fixture");
    item.state = "merge_queue";
    item.githubQueue = {
      position: 2,
      state: "AWAITING_CHECKS",
      line: "Second in the acme/platform GitHub merge queue, waiting for checks.",
    };
    for (const route of [
      { view: "runs", id: run.id },
      { view: "issues", id: item.id },
    ] as const) {
      const page = render(model({ snapshot, route })).content;
      expect(page).toContain("Second in the acme/platform GitHub merge queue, waiting for checks.");
      expect(page).toContain('<span class="result-icon" aria-hidden="true">2</span>');
      expect(page).toContain("Paws does not rebase it or run Closeout again.");
    }
    delete item.githubQueue;
    expect(render(model({ snapshot, route: { view: "runs", id: run.id } })).content).not.toContain(
      "GitHub merge queue",
    );
  });

  test("a run detail renders the verification section", () => {
    const html = render(model({ route: { view: "runs", id: "r-100" } })).content;
    expect(html).toContain("<h2>Closeout</h2>");
    expect(html).toContain("Exhausted");
    expect(html).toContain('data-action="toggle-check"');
    expect(html).not.toContain('aria-label="Candidate"');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).not.toContain("/verdicts");
  });

  test("item activity is a plain section with its links as one row of buttons", () => {
    const snapshot = fullStatusFixture();
    snapshot.source = "live";
    const run = snapshot.runs.find((entry) => entry.state === "running");
    if (!run) throw new Error("missing running run");
    run.links = [{ label: "Linear issue", href: "https://linear.app/acme/issue/ENG-1" }];
    run.activity.push({ at: "2026-10-09T20:20:00.000Z", kind: "tool", text: "bun test" });
    for (const state of ["running", "verifying", "done"] as const) {
      run.state = state;
      const html = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
      const section = activitySection(html);
      expect(html).not.toContain('<details class="run-activity"');
      expect(section).toContain("<h2");
      expect(section).toContain(">Timeline</h2>");
      expect(section).not.toContain(esc(run.summary));
      expect(section).toContain("bun test");
      expect(section).toContain("data-follow");
      const actions = section.slice(0, section.indexOf('class="log"'));
      expect(actions).toContain('<div class="row wrap"><a class="btn" href="');
      expect(actions).toContain(">Open full agent transcript</a>");
      expect(actions).toContain(
        '<a class="btn" href="https://linear.app/acme/issue/ENG-1" target="_blank" rel="noopener noreferrer">Linear issue</a>',
      );
    }
  });

  test("issues, runs, and questions each render", () => {
    const issues = render(model({ route: { view: "issues", id: null } })).content;
    expect(issues).toContain('data-issue-filter="active"');
    expect(issues).toContain("Audit log export");
    expect(render(model({ route: { view: "issues", id: "ENG-104" } })).content).toContain(
      "Admin export UI",
    );
    expect(render(model({ route: { view: "runs", id: "r-103" } })).content).toContain(
      "ask_team → Q-41",
    );
    expect(render(model({ route: { view: "questions", id: "Q-40" } })).content).toContain(
      "legal-hold",
    );
    const snapshot = fullStatusFixture();
    const question = snapshot.questions[0]!;
    question.links = [
      { label: "Answer in Linear", href: "https://linear.app/paws/issue/ENG-1#session" },
    ];
    const html = render(model({ snapshot, route: { view: "questions", id: question.id } })).content;
    expect(html).toContain('href="https://linear.app/paws/issue/ENG-1#session"');
    expect(html).toContain("Answer in Linear");
    expect(html).not.toContain("Read-only.");
  });

  test("an answerable question renders one button per option and a free-text answer", () => {
    const snapshot = fullStatusFixture();
    const question = snapshot.questions[0]!;
    question.answerable = true;
    const html = render(model({ snapshot, route: { view: "questions", id: question.id } })).content;
    expect(html).toContain(`data-question-answer="${question.id}"`);
    expect(html.match(/<button class="opt btn[^"]*" type="submit" name="option"/g)).toHaveLength(
      question.options.length,
    );
    for (const option of question.options) expect(html).toContain(`value="${esc(option)}"`);
    expect(html).toContain("Or write an answer");
    expect(html).toContain('<textarea name="answer"');
    expect(html).toContain('<button class="btn primary" type="submit">Answer</button>');
    expect(html).toContain("Answering here also posts your answer in Linear.");
    expect(html).not.toContain("Answer in the source conversation to continue.");
  });

  test("a merge GitHub refused renders its Retry merge button", () => {
    const snapshot = fullStatusFixture();
    const question = snapshot.questions[0]!;
    question.answerable = true;
    question.options = ["Retry merge"];
    question.body =
      "GitHub refused to merge the pull request with status 405.\n\nGitHub says: At least 1 approving review is required.";
    const html = render(model({ snapshot, route: { view: "questions", id: question.id } })).content;
    expect(html).toContain('type="submit" name="option" value="Retry merge"');
    expect(html).toContain("At least 1 approving review is required.");
  });

  test("a question that is not answerable keeps its read-only options", () => {
    const snapshot = fullStatusFixture();
    const question = snapshot.questions[0]!;
    question.links = [];
    const html = render(model({ snapshot, route: { view: "questions", id: question.id } })).content;
    expect(html).not.toContain("data-question-answer");
    expect(html).not.toContain('name="option"');
    expect(html).not.toContain('<textarea name="answer"');
    question.options.forEach((option, index) =>
      expect(html).toContain(`<span class="mono dim">${index + 1}</span>${esc(option)}`),
    );
    expect(html).toContain('<div class="opt static');
    expect(html).toContain("Answer in the source conversation to continue.");
    expect(html).not.toContain("Answering here also posts your answer in Linear.");
  });

  test("escapes text and drops non-http links", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-104");
    if (!item) throw new Error("missing item");
    item.title = `<script>alert(1)</script>`;
    item.links = [{ label: "bad", href: "javascript:alert(1)" }];
    const html = render(model({ route: { view: "issues", id: item.id }, snapshot })).content;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
  });

  test("a live snapshot hides the engine address and live banner", () => {
    const snapshot = fullStatusFixture();
    snapshot.source = "live";
    const view = render(model({ snapshot, engineUrl: "http://127.0.0.1:8787" }));
    expect(view.top).not.toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.top).not.toContain("Engine");
    expect(view.banner).not.toContain("127.0.0.1:8787");
    expect(view.banner.toLowerCase()).not.toContain("sample");
  });

  test("an empty live database tells the operator to delegate a Linear issue", () => {
    const snapshot = fullStatusFixture();
    snapshot.source = "live";
    snapshot.items = [];
    snapshot.runs = [];
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.mergeQueue = [];
    const view = render(model({ snapshot, engineUrl: "http://127.0.0.1:8787" }));
    expect(view.top).not.toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.content).toContain("No issues yet. Delegate an issue to Paws in Linear.");
    expect(view.content).not.toContain("Audit log export");
  });

  test("retired hashes fall back to issues, an alias the server resolves, or overview", () => {
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("/issues/ENG-104")).toEqual({ view: "issues", id: "ENG-104" });
    expect(parseRoute("/runs/r-102")).toEqual({ view: "alias", kind: "runs", id: "r-102" });
    expect(parseRoute("/questions/Q-41")).toEqual({ view: "questions", id: "Q-41" });
    expect(parseRoute("/epics/x")).toEqual({ view: "issues", id: null });
    expect(parseRoute("/queue")).toEqual({ view: "overview" });
    expect(parseRoute("/verdicts/ENG-101")).toEqual({
      view: "alias",
      kind: "verdicts",
      id: "ENG-101",
    });
    expect(parseRoute("/runs")).toEqual({ view: "issues", id: null });
  });

  test("an alias shows loading until resolved, then the same not-found for absent and hidden ids", () => {
    const route = { view: "alias", kind: "sessions", id: "s-1" } as const;
    expect(render(model({ route, phase: "loading" })).content).toContain("Loading status");
    const missing = render(model({ route, phase: "ready" })).content;
    expect(missing).toContain("Link not found.");
    expect(missing).toContain('href="/issues"');
    expect(missing).not.toContain("No issues yet");
  });
});

function issueRow(html: string, id: string): string {
  const marker = `data-issue-id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`missing issue row ${id}`);
  const start = html.lastIndexOf("<tr", at);
  const end = html.indexOf("</tr>", at);
  return html.slice(start, end);
}

function activitySection(html: string): string {
  const start = html.indexOf('<section class="issue-fold" aria-label="Timeline"');
  if (start < 0) throw new Error("missing item activity");
  return html.slice(start, html.indexOf("</section>", start));
}
