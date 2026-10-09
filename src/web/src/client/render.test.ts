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
    ...patch,
  };
}

describe("status views", () => {
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
    expect(view.banner).toContain("127.0.0.1:8787");
    expect(view.banner.toLowerCase()).not.toContain("sample");
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
