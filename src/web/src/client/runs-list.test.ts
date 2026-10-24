import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { render, type RenderModel } from "./render";
import { parseRunFilters, runFilterSearch } from "./runs-list";
import { themedMarkup } from "./theme";

function runsPage(search = "", snapshot: StatusSnapshot = demoStatus()): string {
  const model: RenderModel = {
    route: { view: "runs", id: null },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
    search,
  };
  return render(model).content;
}

function shownRuns(html: string): string[] {
  return [...html.matchAll(/<tr data-run-id="([^"]+)"/g)].map((match) => match[1]!);
}

function row(html: string, id: string): string {
  const start = html.indexOf(`<tr data-run-id="${id}"`);
  if (start < 0) throw new Error(`missing run row ${id}`);
  return html.slice(start, html.indexOf("</tr>", start));
}

function listPhase(html: string, id: string): string {
  return /<span class="tag" data-run-phase>([^<]+)<\/span>/.exec(row(html, id))?.[1] ?? "";
}

function pagePhase(snapshot: StatusSnapshot, id: string): string {
  const html = render({
    route: { view: "runs", id },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
  }).content;
  return (
    /<li class="run-step [a-z]+" aria-current="step">(?:✓ |✕ )?([^<·]+)/.exec(html)?.[1] ?? ""
  ).trim();
}

describe("runs list", () => {
  test("each row shows the issue, project, lead, phase, status, start, and pull request", () => {
    const html = runsPage();
    expect(shownRuns(html).sort()).toEqual(["r-100", "r-101", "r-102", "r-103", "r-99"]);
    const merging = row(html, "r-101");
    expect(merging).toContain('<span class="lin-id">ENG-101</span> <b>Export job worker</b>');
    expect(merging).toContain('href="/issues/ENG-101"');
    expect(merging).toContain("Audit log export");
    expect(merging).toContain("Jonas Berg");
    expect(listPhase(html, "r-101")).toBe("Waiting to merge");
    expect(merging).toContain('class="st done"');
    expect(merging).toContain("3h 5m ago");
    expect(merging).toContain(
      '<a href="https://github.com/acme/platform/pull/479" target="_blank" rel="noopener noreferrer" aria-label="Pull request 479">#479</a>',
    );
    const running = row(html, "r-102");
    expect(running).toContain("No project");
    expect(running).toContain("Aisha Khan");
    expect(running).not.toContain("github.com");
    expect(running).not.toContain('target="_blank"');
  });

  test("a pull request url that is not http is not linked", () => {
    const snapshot = demoStatus();
    snapshot.items.find((item) => item.id === "ENG-101")!.pr = {
      number: 479,
      url: "javascript:alert(1)",
    };
    expect(row(runsPage("", snapshot), "r-101")).not.toContain("#479");
  });

  test("filters by project, including runs with no project", () => {
    expect(shownRuns(runsPage("?project=approval-audit")).sort()).toEqual([
      "r-100",
      "r-101",
      "r-103",
    ]);
    expect(shownRuns(runsPage("?project=none")).sort()).toEqual(["r-102", "r-99"]);
    expect(shownRuns(runsPage("?project=approval-audit&project=none"))).toHaveLength(5);
  });

  test("filters by lead", () => {
    expect(shownRuns(runsPage("?lead=Aisha+Khan"))).toEqual(["r-102"]);
    expect(shownRuns(runsPage("?lead=Jonas%20Berg")).sort()).toEqual([
      "r-100",
      "r-101",
      "r-103",
      "r-99",
    ]);
  });

  test("filters by run status", () => {
    expect(shownRuns(runsPage("?status=awaiting_input"))).toEqual(["r-103"]);
    expect(shownRuns(runsPage("?status=running&status=awaiting_input")).sort()).toEqual([
      "r-102",
      "r-103",
    ]);
  });

  test("filters by phase", () => {
    expect(shownRuns(runsPage("?phase=closeout"))).toEqual(["r-100"]);
    expect(shownRuns(runsPage("?phase=merge"))).toEqual(["r-101"]);
    expect(shownRuns(runsPage("?phase=complete"))).toEqual(["r-99"]);
    expect(shownRuns(runsPage("?phase=implementation")).sort()).toEqual(["r-102", "r-103"]);
  });

  test("filters combine across groups", () => {
    expect(shownRuns(runsPage("?lead=Jonas+Berg&phase=implementation"))).toEqual(["r-103"]);
    expect(shownRuns(runsPage("?project=none&status=done"))).toEqual(["r-99"]);
  });

  test("selected filters render checked and counted so a reloaded url shows the same list", () => {
    const search = "?project=none&status=done";
    const first = runsPage(search);
    expect(first).toContain('value="none" data-run-filter checked');
    expect(first).toContain('value="done" data-run-filter checked');
    expect(first).toContain("Project · 1");
    expect(first).toContain("Status · 1");
    expect(first).toContain(">Lead</summary>");
    expect(first).toContain("1 of 5 runs");
    expect(runsPage(search)).toBe(first);
    expect(parseRunFilters(runFilterSearch("?engine=x", parseRunFilters(search)))).toEqual(
      parseRunFilters(search),
    );
    expect(runFilterSearch("?engine=x&status=running", parseRunFilters(search))).toBe(
      "?engine=x&project=none&status=done",
    );
  });

  test("offers every run state and phase, the projects that have runs, and no project", () => {
    const html = runsPage();
    for (const label of ["Running", "Awaiting input", "Verifying", "Paused", "Done", "Stopped"])
      expect(html).toContain(`data-run-filter>${label}</label>`);
    for (const label of ["Implementation", "Closeout", "Waiting to merge", "Complete"])
      expect(html).toContain(`data-run-filter>${label}</label>`);
    expect(html).toContain('value="approval-audit" data-run-filter>Audit log export</label>');
    expect(html).toContain('value="none" data-run-filter>No project</label>');
    expect(html).not.toContain(">No lead</label>");
    expect(html).not.toContain("Clear filters");
  });

  test("ignores unknown status and phase values", () => {
    expect(shownRuns(runsPage("?status=bogus&phase=nope"))).toHaveLength(5);
  });

  test("an empty result says so and offers clear filters", () => {
    const html = runsPage("?lead=Aisha+Khan&phase=complete");
    expect(shownRuns(html)).toEqual([]);
    expect(html).toContain("No runs match these filters.");
    expect(html).toContain('<a class="btn" href="/runs">Clear filters</a>');
    expect(html).toContain("0 of 5 runs");
  });

  test("the list phase matches the run page phase for every run", () => {
    const snapshot = demoStatus();
    const html = runsPage("", snapshot);
    for (const run of snapshot.runs)
      expect(listPhase(html, run.id)).toBe(pagePhase(snapshot, run.id));
  });

  test("closeout running again after a rebase shows Closeout in the list and on the run page", () => {
    const snapshot = demoStatus();
    const verdict = snapshot.verdicts.find((entry) => entry.itemId === "ENG-101");
    if (!verdict) throw new Error("missing verdict");
    verdict.decision = "running";
    verdict.attempt = 2;
    const html = runsPage("", snapshot);
    expect(listPhase(html, "r-101")).toBe("Closeout");
    expect(pagePhase(snapshot, "r-101")).toBe("Closeout");
    expect(shownRuns(runsPage("?phase=closeout", snapshot)).sort()).toEqual(["r-100", "r-101"]);
    expect(shownRuns(runsPage("?phase=merge", snapshot))).toEqual([]);
  });

  test("desktop: a queued task says why it waits: blocked, its owner's cap, or no free runner", () => {
    const html = runsPage("", waitingTasks());
    expect(waitText(row(html, "r-100"))).toBe("Blocked by ENG-102");
    expect(waitText(row(html, "r-102"))).toBe(
      "Waiting: its owner already runs 3 tasks, the most at once",
    );
    expect(waitText(row(html, "r-103"))).toBe("Waiting for a free runner");
    expect(waitText(row(html, "r-101"))).toBeNull();
    const page = render({
      route: { view: "runs", id: "r-102" },
      phase: "ready",
      snapshot: waitingTasks(),
      via: "bundled",
      error: null,
      engineUrl: null,
    }).content;
    expect(page).toContain(
      "Waiting: its owner already runs 3 tasks, the most at once. Paws starts ENG-102 when one of them finishes.",
    );
  });

  test("390 px: the wait reason stays in the issue cell that phones show, and wraps", () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, themedMarkup(runsPage("", waitingTasks()))),
    );
    const cell = /<tr [^>]*data-run-id="r-102"><td [^>]*class="([^"]*)">(.*?)<\/td>/.exec(html);
    expect(cell?.[1]).not.toMatch(/\bhidden\b|whitespace-nowrap/);
    expect(cell?.[2]).toContain("Waiting: its owner already runs 3 tasks, the most at once");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });
});

function waitingTasks(): StatusSnapshot {
  const snapshot = demoStatus();
  for (const item of snapshot.items) {
    if (item.id === "ENG-100") Object.assign(item, { state: "queued", blockers: ["ENG-102"] });
    if (item.id === "ENG-102")
      Object.assign(item, {
        state: "queued",
        queue: { position: 2, busySlots: 4, totalSlots: 4, ownerCap: 3 },
      });
    if (item.id === "ENG-103")
      Object.assign(item, { state: "queued", queue: { position: 1, busySlots: 4, totalSlots: 4 } });
  }
  return snapshot;
}

function waitText(html: string): string | null {
  return /data-wait-reason>([^<]+)</.exec(html)?.[1] ?? null;
}
