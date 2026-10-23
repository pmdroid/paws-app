import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import {
  checkHash,
  checkKey,
  emptyCloseoutView,
  parseCheckHash,
  renderCloseoutChecks,
  type CloseoutView,
} from "./closeout";
import { render, type RenderModel } from "./render";
import { themedMarkup } from "./theme";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

function verdict(id: string) {
  const found = demoStatus().verdicts.find((entry) => entry.itemId === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
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
    expect(html).toContain('data-attempt="3" aria-pressed="true"');
    expect(html).toContain('id="check-3-unit"');
    expect(html).not.toContain('id="check-1-unit"');
    const earlier = renderCloseoutChecks(
      verdict("ENG-100"),
      { ...emptyCloseoutView(), attempt: { "ENG-100": 1 } },
      null,
    );
    expect(earlier).toContain('id="check-1-unit"');
    expect(earlier).toContain("Attempt 1<span");
  });

  test("a rebased head's re-check starts its attempt tabs at 1 in a new round", () => {
    const base = verdict("ENG-100");
    const [first, second, third] = base.attempts!;
    const rebased = {
      ...base,
      attempts: [
        { ...first!, round: 1 },
        { ...second!, round: 1 },
        { ...third!, round: 2 },
      ],
    };
    const html = renderCloseoutChecks(rebased, emptyCloseoutView(), null);
    expect(html).toContain('<span class="attempt-round">Round 1</span>');
    expect(html).toContain('<span class="attempt-round">Round 2 · rebased</span>');
    expect(html).toMatch(/data-attempt="3" aria-pressed="true">.*?Attempt 1<span/);
    expect(html).toContain("Exhausted after 1 of 3 attempts in round 2");
    expect(renderCloseoutChecks(base, emptyCloseoutView(), null)).not.toContain("attempt-round");
  });

  test("failed checks start open, passed checks closed, and expand all reflects the rows", () => {
    const failed = renderCloseoutChecks(verdict("ENG-100"), emptyCloseoutView(), null);
    expect(failed).toContain('data-check="unit" aria-expanded="true"');
    expect(failed).toContain('data-check="typecheck" aria-expanded="false"');
    expect(failed).toContain(">Expand all</button>");
    const passed = renderCloseoutChecks(verdict("ENG-101"), emptyCloseoutView(), null);
    expect(passed).not.toContain('aria-expanded="true"');
    expect(passed).toContain('data-action="closeout-attempt"');
    const view: CloseoutView = emptyCloseoutView();
    for (const id of ["typecheck", "unit"]) view.open[checkKey("ENG-100", 3, id)] = true;
    const all = renderCloseoutChecks(verdict("ENG-100"), view, null);
    expect(all).toContain(">Collapse all</button>");
    expect(all).not.toContain('aria-expanded="false"');
  });

  test("an open row shows stdout and stderr apart, in color, with its tools", () => {
    const html = renderCloseoutChecks(verdict("ENG-100"), emptyCloseoutView(), null);
    expect(html).toContain('data-stream="stdout"');
    expect(html).toContain('data-stream="stderr"');
    expect(html).toContain('<span class="ansi-bold ansi-fg-1">error</span>');
    expect(html).toContain('data-log="ENG-100:3:unit:stderr"');
    expect(html).toContain('data-action="wrap-output"');
    expect(html).toContain('data-action="copy-check-link"');
    expect(html).toContain('data-action="download-output"');
    expect(html).toContain('class="out whitespace-pre"');
    const wrapped = renderCloseoutChecks(
      verdict("ENG-100"),
      { ...emptyCloseoutView(), wrap: { [checkKey("ENG-100", 3, "unit")]: true } },
      null,
    );
    expect(wrapped).toContain('class="out whitespace-pre-wrap break-all"');
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
      'href="http://127.0.0.1:8787/api/closeout-artifact?item=ENG-100&amp;check=unit&amp;kind=log&amp;head=6ae7f93&amp;policy=" download="unit-2.log">Full log</a>',
    );
    expect(html).toContain("Output was cut at the size limit.");
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

  test("a check held for an unavailable runner shows why it is waiting", () => {
    const entry = verdict("ENG-100");
    const attempt = entry.attempts!.at(-1)!;
    attempt.decision = "running";
    const install = attempt.checks[0]!;
    install.state = "running";
    install.stdout = "";
    install.stderr = "";
    install.detail = "Waiting: runner goldbox is paused. Resume it on the Runners page.";
    const html = renderCloseoutChecks(
      entry,
      { ...emptyCloseoutView(), open: { [checkKey("ENG-100", attempt.number, install.id)]: true } },
      null,
    );
    expect(html).toContain(`<h3>${install.id} is waiting</h3>`);
    expect(html).toContain(
      "<p>Waiting: runner goldbox is paused. Resume it on the Runners page.</p>",
    );
    expect(html).not.toContain("Waiting for output.");
  });

  test("a run without Closeout has no Closeout section", () => {
    const snapshot = demoStatus();
    snapshot.verdicts = snapshot.verdicts.filter((entry) => entry.itemId !== "ENG-100");
    const html = runPage({ snapshot });
    expect(html).not.toContain('aria-label="Closeout"');
    expect(html).not.toContain("<h3>Checks</h3>");
    expect(runPage({})).toContain('aria-label="Closeout"');
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

test("accepted output describes the actual delivery state instead of assuming a merge queue", () => {
  const entry = verdict("ENG-101");
  const pr = { number: 479, url: "https://github.com/acme/platform/pull/479" };
  const queued = renderCloseoutChecks(entry, emptyCloseoutView(), null, pr, "merge_queue");
  expect(queued).toContain("is waiting to merge");
  const merged = renderCloseoutChecks(entry, emptyCloseoutView(), null, pr, "merged");
  expect(merged).toContain("This change has merged");
  expect(merged).not.toContain("is waiting to merge");
  const signoff = renderCloseoutChecks(entry, emptyCloseoutView(), null, pr, "signoff");
  expect(signoff).toContain("Waiting for human sign-off");
  expect(signoff).not.toContain("is waiting to merge");
});

describe("independent review measurements", () => {
  function measured() {
    const entry = verdict("ENG-101");
    const review = entry.checks.find((check) => check.kind === "review")!;
    review.elapsedMs = 192_000;
    review.tokens = 52_300;
    return entry;
  }

  test("desktop: the review row shows how long it took and the tokens it used", () => {
    const html = renderCloseoutChecks(measured(), emptyCloseoutView(), null);
    expect(html).toContain('<span class="check-meta">3m 12s · 52.3k tokens</span>');
  });

  test("390 px: the review measurements wrap under the check name", () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        themedMarkup(renderCloseoutChecks(measured(), emptyCloseoutView(), null)),
      ),
    );
    expect(html).toContain("3m 12s · 52.3k tokens");
    expect(css).toMatch(
      /@media \(max-width: 900px\) \{[^@]*\.check-row \.check-meta \{[^}]*white-space: normal;/,
    );
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });

  test("a measured review survives the status contract", () => {
    const snapshot = demoStatus();
    snapshot.verdicts = [measured()];
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
    if (!parsed.ok) throw new Error(parsed.error);
    const review = parsed.snapshot.verdicts[0]!.checks.find((check) => check.kind === "review");
    expect(review?.tokens).toBe(52_300);
  });
});
