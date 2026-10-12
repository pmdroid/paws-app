import { describe, expect, test } from "bun:test";
import { demoStatus } from "../demo";
import { render, type RenderModel } from "./render";
import { parseRoute } from "./route";

function model(patch: Partial<RenderModel> = {}): RenderModel {
  return {
    route: { view: "overview" },
    phase: "ready",
    snapshot: demoStatus(),
    via: "bundled",
    error: null,
    engineUrl: null,
    epicView: "graph",
    selectedCheck: null,
    ...patch,
  };
}

describe("status views", () => {
  test("overview follows the current run after recovery and falls back to the item before a new run", () => {
    const snapshot = demoStatus();
    const run = snapshot.runs[0];
    const item = snapshot.items.find((entry) => entry.id === run?.itemId);
    if (!run || !item) throw new Error("missing fixture");
    item.state = "running";
    item.runId = "current-run";
    snapshot.items = [item];
    snapshot.runs = [
      { ...run, id: "old-run", state: "done" },
      { ...run, id: "current-run", state: "running" },
    ];
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.mergeQueue = [];
    const running = render(model({ snapshot })).content;
    expect(running).toContain('href="#/runs/current-run"');
    expect(running).not.toContain('href="#/runs/old-run"');
    expect(running).toContain('class="st running"');
    item.state = "queued";
    item.runId = null;
    const queued = render(model({ snapshot })).content;
    expect(queued).toContain(`href="#/epics/${item.epicId}"`);
    expect(queued).not.toContain('href="#/runs/old-run"');
    expect(queued).not.toContain('href="#/runs/current-run"');
    expect(queued).toContain('class="st queued"');
  });

  test("terminal closeout outcomes override a stale verifying run in both views", () => {
    for (const [decision, detail] of [
      ["blocked", "Closeout is blocked and needs a person."],
      ["exhausted", "Closeout stopped after its retry budget."],
    ] as const) {
      const snapshot = demoStatus();
      const verdict = snapshot.verdicts[0];
      const item = snapshot.items.find((entry) => entry.id === verdict?.itemId);
      const run = snapshot.runs.find((entry) => entry.itemId === item?.id);
      if (!verdict || !item || !run) throw new Error("missing fixture");
      verdict.decision = decision;
      item.state = decision === "blocked" ? "needs_human" : "exhausted";
      run.state = "verifying";
      for (const route of [
        { view: "verdicts", id: item.id },
        { view: "runs", id: run.id },
      ] as const) {
        const html = render(model({ snapshot, route })).content;
        expect(html).toContain(detail);
        expect(html).not.toContain("Closeout is verifying this candidate.");
      }
    }
  });
  test("artifact links use the selected engine and wait for completed checks", () => {
    const snapshot = demoStatus();
    const verdict = snapshot.verdicts[0];
    const check = verdict?.checks[0];
    if (!verdict || !check) throw new Error("missing verdict");
    check.logPath = "logs/check/1.log";
    check.evidencePath = "evidence/check/1.json";
    check.stdout = "Live output\n";
    const input = model({
      snapshot,
      engineUrl: "https://engine.example/api/status",
      route: { view: "verdicts", id: verdict.itemId },
    });
    expect(render(input).content).toContain('href="https://engine.example/api/closeout-artifact?');
    check.state = "running";
    check.active = true;
    const live = render(input).content;
    expect(live).not.toContain("/api/closeout-artifact?");
    expect(live).toContain("Download log");
  });

  test("overview labels demo data and lists the sample epic, question, and queue", () => {
    const view = render(model());
    expect(view.top).toContain("Demo data");
    expect(view.banner.toLowerCase()).toContain("sample");
    expect(view.content).toContain("Audit log export");
    expect(view.content).toContain("Q-41");
    expect(view.content).toContain("Merge queue");
    expect(view.content).not.toContain("javascript:");
  });

  test("epics, runs, questions, verdicts, and the queue each render", () => {
    expect(render(model({ route: { view: "epics", id: "ENG-98" } })).content).toContain("ENG-104");
    expect(render(model({ route: { view: "runs", id: "r-103" } })).content).toContain(
      "Parked on Q-41",
    );
    expect(render(model({ route: { view: "questions", id: "Q-40" } })).content).toContain(
      "legal-hold",
    );
    expect(render(model({ route: { view: "verdicts", id: "ENG-100" } })).content).toContain(
      "Exhausted",
    );
    expect(render(model({ route: { view: "queue" } })).content).toContain("Rebase onto main");
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
    const epic = snapshot.epics[0];
    if (!epic) throw new Error("missing epic");
    epic.title = `<script>alert(1)</script>`;
    epic.links = [{ label: "bad", href: "javascript:alert(1)" }];
    const html = render(model({ route: { view: "epics", id: epic.id }, snapshot })).content;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
  });

  test("a live snapshot is labeled live", () => {
    const snapshot = demoStatus();
    snapshot.source = "live";
    const view = render(model({ snapshot, via: "engine", engineUrl: "http://127.0.0.1:8787" }));
    expect(view.top).toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.banner).toContain("127.0.0.1:8787");
    expect(view.banner.toLowerCase()).not.toContain("sample");
  });

  test("an empty live database tells the operator to label a Linear issue", () => {
    const snapshot = demoStatus();
    snapshot.source = "live";
    snapshot.epics = [];
    snapshot.items = [];
    snapshot.runs = [];
    snapshot.questions = [];
    snapshot.verdicts = [];
    snapshot.mergeQueue = [];
    snapshot.events = [];
    const view = render(model({ snapshot, via: "engine", engineUrl: "http://127.0.0.1:8787" }));
    expect(view.top).toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.content).toContain("No items yet. Add the `paws` label to a Linear issue.");
    expect(view.content).not.toContain("Audit log export");
  });

  test("hash routes cover every status section", () => {
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("#/epics/ENG-98")).toEqual({ view: "epics", id: "ENG-98" });
    expect(parseRoute("#/runs/r-102")).toEqual({ view: "runs", id: "r-102" });
    expect(parseRoute("#/questions/Q-41")).toEqual({ view: "questions", id: "Q-41" });
    expect(parseRoute("#/verdicts/ENG-101")).toEqual({ view: "verdicts", id: "ENG-101" });
    expect(parseRoute("#/queue")).toEqual({ view: "queue" });
  });
});
