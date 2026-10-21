import { describe, expect, test } from "bun:test";
import { demoStatus } from "../demo";
import { render, type RenderModel } from "./render";
import { parseRoute } from "./route";
import { checkKey } from "./closeout";
import { esc } from "./format";

function model(patch: Partial<RenderModel> = {}): RenderModel {
  return {
    route: { view: "overview" },
    phase: "ready",
    snapshot: demoStatus(),
    via: "bundled",
    error: null,
    engineUrl: null,
    ...patch,
  };
}

describe("status views", () => {
  test("overview follows only the current run after recovery and summarizes queued work", () => {
    const snapshot = demoStatus();
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
    expect(running).toContain('href="/runs/current-run"');
    expect(running).not.toContain('href="/runs/old-run"');
    expect(running).toContain('class="st running"');
    item.state = "queued";
    item.runId = null;
    const queued = render(model({ snapshot })).content;
    expect(queued).toContain("1 queued");
    expect(queued).toContain('href="/issues"');
    expect(queued).not.toContain('href="/runs/old-run"');
    expect(queued).not.toContain('href="/runs/current-run"');
    expect(queued).not.toContain("Working now</h2>\n      <ul");
  });

  test("terminal closeout outcomes override a stale verifying run in both views", () => {
    for (const [decision, detail] of [
      ["blocked", "Closeout blocked"],
      ["exhausted", "Closeout exhausted"],
    ] as const) {
      const snapshot = demoStatus();
      const verdict = snapshot.verdicts[0];
      const item = snapshot.items.find((entry) => entry.id === verdict?.itemId);
      const run = snapshot.runs.find((entry) => entry.itemId === item?.id);
      if (!verdict || !item || !run) throw new Error("missing fixture");
      verdict.decision = decision;
      item.state = decision === "blocked" ? "needs_human" : "exhausted";
      run.state = "verifying";
      const html = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
      expect(html).toContain("<h2>Closeout</h2>");
      expect(html).toContain(detail);
      expect(html).not.toContain("Closeout is verifying this candidate.");
    }
  });
  test("artifact links use the selected engine and wait for completed checks", () => {
    const snapshot = demoStatus();
    const verdict = snapshot.verdicts[0];
    const check = verdict?.checks[0];
    const run = snapshot.runs.find((entry) => entry.itemId === verdict?.itemId);
    if (!verdict || !check || !run) throw new Error("missing verdict");
    check.logPath = "logs/check/1.log";
    check.evidencePath = "evidence/check/1.json";
    check.stdout = "Live output\n";
    const input = model({
      snapshot,
      engineUrl: "https://engine.example/api/status",
      route: { view: "runs", id: run.id },
      closeout: { attempt: {}, open: { [checkKey(verdict.itemId, 1, check.id)]: true }, wrap: {} },
    });
    expect(render(input).content).toContain('href="https://engine.example/api/closeout-artifact?');
    check.state = "running";
    check.active = true;
    const live = render(input).content;
    expect(live).not.toContain("/api/closeout-artifact?");
    expect(live).toContain("Download output");
  });

  test("overview leads with actions and active work instead of delivery and raw events", () => {
    const view = render(model());
    expect(view.top).not.toContain("Demo data");
    expect(view.top).not.toContain("Refresh");
    expect(view.banner).toBe("");
    expect(view.content).toContain("Needs you");
    expect(view.content).toContain("Working now");
    expect(view.content).toContain('href="/questions/Q-41"');
    expect(view.content).toContain("Answer question");
    expect(view.content).toContain("Closeout requirement unit exhausted (3/3)");
    expect(view.content).toContain("2 need you · 1 working · 1 queued · 1 waiting to merge");
    expect(view.content).toContain('href="/runs/r-102"');
    expect(view.content).toContain("All issues");
    expect(view.content).not.toContain("Delivery");
    expect(view.content).not.toContain("Recent events");
    expect(view.content).not.toContain("Export job worker");
    expect(view.content).not.toContain("Admin export UI");
    expect(view.content).not.toContain('href="/queue"');
    expect(view.content).not.toContain("/epics");
    expect(view.content).not.toContain("javascript:");
    expect(view.content.match(/Signed URL delivery/g)).toHaveLength(1);
    expect(view.content.match(/Retention policy enforcement job/g)).toHaveLength(1);
  });

  test("overview includes sign-off and input holds without a question and excludes blocked or paused work", () => {
    const snapshot = demoStatus();
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.items[0]!.state = "signoff";
    snapshot.items[2]!.blockers = [snapshot.items[0]!.id];
    const html = render(model({ snapshot })).content;
    expect(html).toContain("Review sign-off");
    expect(html).toContain("Waiting for your input.");
    expect(html).toContain("0 working");
    expect(html).not.toContain('href="/runs/r-102"');
    snapshot.items[2]!.blockers = [];
    snapshot.runs[0]!.state = "paused";
    const paused = render(model({ snapshot })).content;
    expect(paused).toContain("This run is paused.");
    expect(paused).toContain("0 working");
  });

  test("overview does not count stale runs and keeps completed work out of active work", () => {
    const snapshot = demoStatus();
    snapshot.questions = [];
    snapshot.items = snapshot.items.filter((item) => item.state === "merged");
    const html = render(model({ snapshot })).content;
    expect(html).toContain("0 need you · 0 working");
    expect(html).toContain("Nothing needs your attention.");
    expect(html).toContain("No work is running right now.");
    expect(html).not.toContain("Audit event schema v2");
  });

  test("overview keeps questions reachable with no items and gives new work a useful empty state", () => {
    const snapshot = demoStatus();
    snapshot.items = [];
    const html = render(model({ snapshot })).content;
    expect(html).toContain('href="/questions/Q-41"');
    snapshot.questions = [];
    expect(render(model({ snapshot })).content).toContain("Delegate an issue to Paws in Linear.");
  });

  test("overview bounds the active list and links to all remaining work", () => {
    const snapshot = demoStatus();
    const item = snapshot.items[2]!;
    snapshot.items = Array.from({ length: 9 }, (_, index) => ({
      ...item,
      id: `WORK-${index}`,
      title: `Task ${index}`,
      runId: null,
      blockers: [],
    }));
    snapshot.questions = [];
    snapshot.verdicts = [];
    const html = render(model({ snapshot })).content;
    expect(html).toContain("9 working");
    expect(html).toContain("View all 9 working issues");
    expect(html.match(/class="overview-row"/g)).toHaveLength(6);
    expect(html).not.toContain("Task 6");
  });

  test("issue filters keep in-progress work out of Done", () => {
    const snapshot = demoStatus();
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

  test("issues list shows the owner, project, and unmerged blockers", () => {
    const html = render(model({ route: { view: "issues", id: null } })).content;
    const blocked = issueRow(html, "ENG-104");
    expect(blocked).toContain("Aisha Khan");
    expect(blocked).toContain("Audit log export");
    expect(blocked).toContain("Blocked by ENG-101, ENG-102, ENG-103");
    const solo = issueRow(html, "ENG-102");
    expect(solo).toContain("Aisha Khan");
    expect(solo).not.toContain("Audit log export");
    expect(solo).not.toContain("Blocked by");
    const detail = render(model({ route: { view: "issues", id: "ENG-101" } })).content;
    expect(detail).toContain("Jonas Berg");
    expect(detail).toContain("Audit log export");
    expect(detail).toContain('href="/runs/r-101"');
    expect(detail).toContain("PR #479");
    expect(detail).toContain('href="/issues/ENG-99"');
    expect(detail).toContain('href="/issues/ENG-104"');
  });

  test("a run detail names the implementer's model label", () => {
    const snapshot = demoStatus();
    const run = snapshot.runs[0]!;
    run.model = "Opus 5.5 · 1M context";
    const html = render(model({ snapshot, route: { view: "runs", id: run.id } })).content;
    expect(html).toContain(`${run.agent} · Opus 5.5 · 1M context`);
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

  test("task activity is a plain section with its links as one row of buttons", () => {
    const snapshot = demoStatus();
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
      expect(section).toContain("Task activity and agent transcript");
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
    const snapshot = demoStatus();
    const question = snapshot.questions[0]!;
    question.links = [
      { label: "Answer in Linear", href: "https://linear.app/paws/issue/ENG-1#session" },
    ];
    const html = render(model({ snapshot, route: { view: "questions", id: question.id } })).content;
    expect(html).toContain('href="https://linear.app/paws/issue/ENG-1#session"');
    expect(html).toContain("Answer in Linear");
    expect(html).not.toContain("Read-only.");
  });

  test("escapes text and drops non-http links", () => {
    const snapshot = demoStatus();
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
    const snapshot = demoStatus();
    snapshot.source = "live";
    const view = render(model({ snapshot, via: "engine", engineUrl: "http://127.0.0.1:8787" }));
    expect(view.top).not.toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.top).not.toContain("Engine");
    expect(view.banner).not.toContain("127.0.0.1:8787");
    expect(view.banner.toLowerCase()).not.toContain("sample");
  });

  test("an empty live database tells the operator to delegate a Linear issue", () => {
    const snapshot = demoStatus();
    snapshot.source = "live";
    snapshot.items = [];
    snapshot.runs = [];
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.mergeQueue = [];
    snapshot.events = [];
    const view = render(model({ snapshot, via: "engine", engineUrl: "http://127.0.0.1:8787" }));
    expect(view.top).not.toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.content).toContain("No issues yet. Delegate an issue to Paws in Linear.");
    expect(view.content).not.toContain("Audit log export");
  });

  test("retired hashes fall back to issues, the matching run, or overview", () => {
    const snapshot = demoStatus();
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("/issues/ENG-104")).toEqual({ view: "issues", id: "ENG-104" });
    expect(parseRoute("/runs/r-102")).toEqual({ view: "runs", id: "r-102" });
    expect(parseRoute("/questions/Q-41")).toEqual({ view: "questions", id: "Q-41" });
    expect(parseRoute("/epics/x")).toEqual({ view: "issues", id: null });
    expect(parseRoute("/epics/ENG-98", snapshot)).toEqual({ view: "issues", id: null });
    expect(parseRoute("/queue")).toEqual({ view: "overview" });
    expect(parseRoute("/verdicts/ENG-101", snapshot)).toEqual({ view: "runs", id: "r-101" });
    expect(parseRoute("/verdicts/missing", snapshot)).toEqual({ view: "runs", id: "missing" });
    expect(parseRoute("/verdicts/ENG-101")).toEqual({ view: "runs", id: null });
  });
});

function issueRow(html: string, id: string): string {
  const marker = `data-issue-id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`missing issue row ${id}`);
  const start = html.lastIndexOf("<li", at);
  const end = html.indexOf("</li>", at);
  return html.slice(start, end);
}

function activitySection(html: string): string {
  const start = html.indexOf('<section class="run-activity"');
  if (start < 0) throw new Error("missing task activity");
  return html.slice(start, html.indexOf("</section>", start));
}
