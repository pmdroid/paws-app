import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusAgentCloseout, StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { agentSectionKey, agentVerdict, renderAgentCloseout } from "./agent-closeout";
import { checkKey, emptyCloseoutView } from "./closeout";
import { render } from "./render";
import { routeHref } from "./route";
import { themedMarkup } from "./theme";

function demoAgent(): StatusAgentCloseout {
  return demoStatus().agentCloseout![0]!;
}

function runPage(
  snapshot: StatusSnapshot,
  open: Record<string, boolean> = {},
  id = "r-102",
): string {
  return render({
    route: { view: "runs", id },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
    closeout: { ...emptyCloseoutView(), open },
  }).content;
}

describe("Agent Closeout", () => {
  test("while implementing, a running check shows its attempt, elapsed time and the progress", () => {
    const html = runPage(demoStatus());
    expect(html).toContain('aria-label="Agent Closeout"');
    expect(html).toContain("<h2>Agent Closeout</h2>");
    expect(html).not.toContain('aria-label="Closeout"');
    expect(html).toContain("Implementation · Agent Closeout 4 of 7 passed");
    expect(html).toContain("test is running · attempt 2 of 3");
    expect(html).toContain(
      "The agent fixed the failing check and is running it again on head 4be81d0 for 1m 14s. 4 of 7 passed, 2 pending.",
    );
    expect(html).toContain('id="agent-check-2-test"');
    expect(html).toContain('<span class="ico running" aria-label="running">');
    expect(html).toContain("attempt 2 of 3 · 1m 14s");
    expect(html).toContain("Waiting for output.");
    for (const number of [1, 2])
      expect(html).toContain(
        `data-action="closeout-attempt" data-item="agent:r-102" data-attempt="${number}"`,
      );
  });

  test("a failed attempt shows its output when the reader opens it", () => {
    const agent = demoAgent();
    const html = renderAgentCloseout(
      agent,
      { ...emptyCloseoutView(), attempt: { "agent:r-102": 1 } },
      null,
      false,
    );
    expect(html).toContain("test failed · attempt 1 of 3");
    expect(html).toContain("The agent ran it again in attempt 2 on head 2c41f9a.");
    expect(html).toContain('<span class="ico failed" aria-label="failed">✕</span>');
    expect(html).toContain("attempt 1 of 3 · 1m 12s · exit 1");
    expect(html).toContain("escapes quotes inside quoted fields");
    expect(html).toContain("at packages/audit/format/csv.test.ts:41:27");
    expect(html).toContain('id="agent-check-1-test-out"');
    expect(html).not.toContain('id="agent-check-1-lint-out"');
  });

  test("an exhausted check says the agent stopped retrying", () => {
    const agent = demoAgent();
    const last = agent.attempts.at(-1)!;
    agent.attempts.push({
      ...last,
      number: 3,
      decision: "exhausted",
      checks: last.checks.map((check) =>
        check.id === "test"
          ? {
              ...check,
              state: "exhausted",
              attempt: 3,
              active: false,
              exitCode: 1,
              elapsedMs: 70_000,
              stderr: "still failing",
            }
          : check,
      ),
    });
    const html = renderAgentCloseout(agent, emptyCloseoutView(), null, false);
    expect(html).toContain("test is exhausted · attempt 3 of 3");
    expect(html).toContain(
      "The agent stopped retrying on head 4be81d0. Paws asks the team how to continue.",
    );
    expect(html).toContain('<span class="ico exhausted" aria-label="exhausted">✕</span>');
    expect(html).toContain("still failing");
    expect(agentVerdict(agent).decision).toBe("exhausted");
  });

  test("once Paws Closeout starts, it sits above Agent Closeout, which stays collapsed until opened", () => {
    const snapshot = demoStatus();
    snapshot.items = snapshot.items.map((item) =>
      item.id === "ENG-102" ? { ...item, state: "verifying" } : item,
    );
    snapshot.runs = snapshot.runs.map((run) =>
      run.id === "r-102" ? { ...run, state: "verifying" } : run,
    );
    snapshot.verdicts.push({ ...snapshot.verdicts[1]!, itemId: "ENG-102", decision: "running" });
    const html = runPage(snapshot);
    const paws = html.indexOf('aria-label="Closeout"');
    const agent = html.indexOf('aria-label="Agent Closeout"');
    expect(paws).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(paws);
    expect(html).toContain('data-action="agent-closeout-toggle"');
    expect(html).toContain('aria-expanded="false"><h2>Agent Closeout</h2>');
    expect(html).not.toContain('id="agent-check-2-test"');

    const opened = runPage(snapshot, { [agentSectionKey("r-102")]: true });
    expect(opened).toContain('aria-expanded="true"><h2>Agent Closeout</h2>');
    expect(opened).toContain('id="agent-check-2-test"');
    expect(opened).toContain("test is running · attempt 2 of 3");
    expect(opened.indexOf('id="agent-check-2-test"')).toBeGreaterThan(paws);
  });

  test("agent rows keep their own open state apart from Paws Closeout rows", () => {
    const agent = demoAgent();
    const closed = renderAgentCloseout(
      agent,
      { ...emptyCloseoutView(), open: { [checkKey("agent:r-102", 2, "test")]: false } },
      null,
      false,
    );
    expect(closed).not.toContain('id="agent-check-2-test-out"');
    const pawsOnly = renderAgentCloseout(
      agent,
      { ...emptyCloseoutView(), open: { [checkKey("ENG-102", 2, "test")]: false } },
      null,
      false,
    );
    expect(pawsOnly).toContain('id="agent-check-2-test-out"');
  });

  test("desktop: an ended engine run shows its unfinished check as stopped at the run's end, on the issue page", () => {
    for (const generatedAt of ["2026-10-22T05:06:00.000Z", "2026-10-22T06:30:00.000Z"]) {
      const snapshot = endedRun();
      snapshot.generatedAt = generatedAt;
      const html = runPage(snapshot);
      expect(html).toContain("Stopped: the run ended before this check finished");
      expect(html).toContain("test ran for 9m 25s until the run ended at 04:15 UTC");
      expect(html).toContain('<span class="ico stopped" aria-label="stopped">■</span>');
      expect(html).toContain("attempt 2 of 3 · 9m 25s");
      expect(html).not.toContain("is running");
      // The issue page holds every engine run, so it does not send the reader to another page.
      expect(html).not.toContain("This item continues in run");
      expect(html).not.toContain(routeHref({ view: "runs", id: CURRENT }));
    }
  });

  test("390 px: the stopped check wraps instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, themedMarkup(runPage(endedRun()))),
    );
    expect(html).toContain("Stopped: the run ended before this check finished");
    expect(html).not.toContain(CURRENT);
    expect(classNames(html, "run-continues")).toHaveLength(0);
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });

  test("the item's current run shows its own Agent Closeout under the same run page", () => {
    const snapshot = endedRun();
    snapshot.runs = snapshot.runs.map((run) =>
      run.id === "r-102" ? { ...run, attempts: ["r-102", CURRENT] } : run,
    );
    const current = demoAgent();
    current.runId = CURRENT;
    snapshot.agentCloseout!.push(current);
    const html = runPage(snapshot, {}, CURRENT);
    expect(html).toContain("test is running · attempt 2 of 3");
    expect(html).not.toContain("Stopped: the run ended before this check finished");
    expect(html).not.toContain("This item continues in run");
  });
});

const CURRENT = "c1b566d1-d000-4322-809e-0e36a2af3f93";

function endedRun(): StatusSnapshot {
  const snapshot = demoStatus();
  const agent = snapshot.agentCloseout![0]!;
  agent.endedAt = "2026-10-22T04:15:48.000Z";
  agent.continuesIn = CURRENT;
  const last = agent.attempts.at(-1)!;
  last.checks = last.checks.map((check) =>
    check.state === "running"
      ? {
          ...check,
          state: "stopped",
          active: false,
          elapsedMs: 565_000,
          detail: "Stopped: the run ended before this check finished.",
        }
      : check,
  );
  return snapshot;
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}
