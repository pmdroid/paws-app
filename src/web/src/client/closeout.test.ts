import { describe, expect, test } from "bun:test";
import { parseStatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import {
  checkHash,
  checkKey,
  emptyCloseoutView,
  checkDuration,
  parseCheckHash,
  renderCloseout,
  type CloseoutContext,
  type CloseoutView,
} from "./closeout";
import { render, type RenderModel } from "./render";

function verdict(id: string) {
  const found = demoStatus().verdicts.find((entry) => entry.itemId === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const NO_PR: CloseoutContext = { pullRequest: null, waitingToMerge: false, reviewer: "Codex" };

function renderCloseoutChecks(
  entry: ReturnType<typeof verdict>,
  view: CloseoutView,
  engineUrl: string | null,
  context: CloseoutContext = NO_PR,
): string {
  return renderCloseout(entry, view, engineUrl, context);
}

function runPage(patch: Partial<RenderModel>): string {
  return render({
    route: { view: "runs", id: "r-100" },
    phase: "ready",
    snapshot: demoStatus(),
    via: "bundled",
    error: null,
    engineUrl: null,
    ...patch,
  }).content;
}

describe("closeout checks", () => {
  test("the demo snapshot with attempts passes the contract", () => {
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(demoStatus())));
    if (!parsed.ok) throw new Error(parsed.error);
    const attempts = parsed.snapshot.verdicts.find((entry) => entry.itemId === "ENG-100")?.attempts;
    expect(attempts?.map((entry) => entry.decision)).toEqual(["rejected", "rejected", "exhausted"]);
  });

  test("opens on the latest attempt and lists every attempt in the switcher", () => {
    const html = renderCloseoutChecks(verdict("ENG-100"), emptyCloseoutView(), null);
    for (const number of [1, 2, 3])
      expect(html).toContain(
        `data-action="closeout-attempt" data-item="ENG-100" data-attempt="${number}"`,
      );
    expect(html).toContain(
      'data-attempt="3" aria-pressed="true" aria-label="Attempt 3, exhausted"',
    );
    expect(html).toContain("Exhausted after 3 of 3 attempts");
    expect(html).toContain("unit failed every attempt.");
    expect(html).toContain('id="check-3-unit"');
    expect(html).not.toContain('id="check-1-unit"');
    const earlier = renderCloseoutChecks(
      verdict("ENG-100"),
      { ...emptyCloseoutView(), attempt: { "ENG-100": 1 } },
      null,
    );
    expect(earlier).toContain('id="check-1-unit"');
    expect(earlier).toContain('aria-label="Attempt 1, failed"');
    expect(earlier).toContain("Failed on attempt 1 of 3");
  });

  test("failed checks start open, passed checks closed, and expand all reflects the rows", () => {
    const failed = renderCloseoutChecks(verdict("ENG-100"), emptyCloseoutView(), null);
    expect(failed).toContain('data-check="unit" aria-expanded="true"');
    expect(failed).toContain('data-check="typecheck" aria-expanded="false"');
    expect(failed).toContain(">Expand all</button>");
    const passed = renderCloseoutChecks(verdict("ENG-101"), emptyCloseoutView(), null);
    expect(passed).not.toContain('aria-expanded="true"');
    expect(passed).toContain('aria-label="Attempt 1, passed"');
    const view: CloseoutView = emptyCloseoutView();
    for (const id of ["typecheck", "unit"]) view.open[checkKey("ENG-100", 3, id)] = true;
    const all = renderCloseoutChecks(verdict("ENG-100"), view, null);
    expect(all).toContain(">Collapse all</button>");
    expect(all).not.toContain('aria-expanded="false"');
  });

  test("an open row shows stdout and stderr in tabs, in color, with its tools", () => {
    const html = renderCloseoutChecks(verdict("ENG-100"), emptyCloseoutView(), null);
    expect(html).toContain(
      'data-stream="stdout" data-item="ENG-100" data-attempt="3" data-check="unit" aria-pressed="true">stdout</button>',
    );
    expect(html).toContain(
      'data-stream="stderr" data-item="ENG-100" data-attempt="3" data-check="unit" aria-pressed="false">stderr</button>',
    );
    expect(html).toContain('data-log="ENG-100:3:unit:stdout"');
    expect(html).toContain("$ bun test");
    expect(html).toContain("attempt 3 · 18.2s");
    expect(html).toContain('<span class="chk-meta">18.2s · exit 1</span>');
    const stderr = renderCloseoutChecks(
      verdict("ENG-100"),
      { ...emptyCloseoutView(), stream: { [checkKey("ENG-100", 3, "unit")]: "stderr" } },
      null,
    );
    expect(stderr).toContain('<span class="ansi-bold ansi-fg-1">error</span>');
    expect(stderr).toContain('data-log="ENG-100:3:unit:stderr"');
    expect(html).toContain('data-action="wrap-output"');
    expect(html).toContain('data-action="copy-check-link"');
    expect(html).toContain('data-action="download-output"');
    expect(html).toContain('class="term-out whitespace-pre"');
    const wrapped = renderCloseoutChecks(
      verdict("ENG-100"),
      { ...emptyCloseoutView(), wrap: { [checkKey("ENG-100", 3, "unit")]: true } },
      null,
    );
    expect(wrapped).toContain('class="term-out whitespace-pre-wrap break-all"');
    expect(wrapped).toContain(
      'data-action="wrap-output" data-item="ENG-100" data-attempt="3" data-check="unit" aria-pressed="true"',
    );
  });

  test("a finished check links its full log for that attempt's head and says when output was cut", () => {
    const entry = verdict("ENG-100");
    const attempt = entry.attempts![1]!;
    const unit = attempt.checks.find((check) => check.id === "unit")!;
    unit.logPath = "logs/p/6ae7f93/unit/2.log";
    unit.truncated = true;
    const html = renderCloseoutChecks(
      entry,
      { ...emptyCloseoutView(), attempt: { "ENG-100": 2 } },
      "http://127.0.0.1:8787",
    );
    expect(html).toContain(
      'class="btn sm" href="http://127.0.0.1:8787/api/closeout-artifact?item=ENG-100&amp;check=unit&amp;kind=log&amp;head=6ae7f93&amp;policy=" download="unit-2.log">Full log</a>',
    );
    expect(html).toContain("Showing the end of the output. Full log has all of it.");
    expect(html).not.toContain('data-action="download-output"');
    unit.state = "running";
    unit.active = true;
    const running = renderCloseoutChecks(
      entry,
      { ...emptyCloseoutView(), attempt: { "ENG-100": 2 } },
      null,
    );
    expect(running).toContain("The full log is available once the check finishes.");
    expect(running).not.toContain("/api/closeout-artifact");
  });

  test("a run without Closeout has no Closeout section", () => {
    const snapshot = demoStatus();
    snapshot.verdicts = snapshot.verdicts.filter((entry) => entry.itemId !== "ENG-100");
    const html = runPage({ snapshot });
    expect(html).not.toContain('aria-label="Closeout"');
    expect(html).not.toContain("result-banner");
    expect(runPage({})).toContain('aria-label="Closeout"');
  });

  test("an accepted attempt says how many checks passed, on which head, and the pull request", () => {
    const html = renderCloseoutChecks(verdict("ENG-101"), emptyCloseoutView(), null, {
      pullRequest: 479,
      waitingToMerge: true,
      reviewer: "Claude",
    });
    expect(html).toContain("Accepted on attempt 1 of 3");
    expect(html).toContain(
      "All 3 checks passed on head b7e21aa. Pull request #479 is waiting to merge.",
    );
    expect(html).toContain(
      '<span class="chk-cmd" title="reviewer Codex, different session">independent review by Claude</span>',
    );
    expect(html).not.toContain("Sealed");
  });

  test("durations read like the mocks", () => {
    expect(checkDuration(3_140)).toBe("3.1s");
    expect(checkDuration(24_200)).toBe("24.2s");
    expect(checkDuration(134_000)).toBe("2m 14s");
    expect(checkDuration(123_000)).toBe("2m 03s");
  });

  test("copied links round-trip the attempt and check id", () => {
    expect(checkHash(2, "lint/web a")).toBe("#check=2/lint%2Fweb%20a");
    expect(parseCheckHash(checkHash(2, "lint/web a"))).toEqual({
      attempt: 2,
      checkId: "lint/web a",
    });
    expect(parseCheckHash("#/runs/x")).toBeNull();
    expect(parseCheckHash("#check=1/%E0%A4%A")).toBeNull();
  });
});
