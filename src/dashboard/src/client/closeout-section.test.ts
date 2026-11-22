import { describe, expect, test } from "bun:test";
import type { StatusCheck } from "../contract";
import {
  fullStatusFixture,
  openedView,
  pageData,
  withOpenP1,
  withRuleResults,
} from "../../test/fixtures";
import { emptyCloseoutView, type CloseoutView } from "./closeout";
import { render } from "./render";

type Full = ReturnType<typeof fullStatusFixture>;

function issuePage(full: Full, id: string, closeout: CloseoutView = emptyCloseoutView()) {
  const data = pageData(full, { view: "issues", id });
  data.issue!.risk = {
    tier: "normal",
    head: "b7e21aa",
    base: "a1c9e07",
    classifiedAt: null,
    paths: [],
    securityReview: null,
  };
  return render({ phase: "ready", error: null, engineUrl: null, closeout, ...data }).content;
}

function section(html: string): string {
  const start = html.indexOf('<section class="issue-fold closeout-overview');
  return html.slice(start, html.indexOf('<section class="issue-fold history-section', start));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the issue page's Closeout section", () => {
  test("an accepted verdict says the decision, commit, round, counts and risk", () => {
    const html = section(issuePage(fullStatusFixture(), "ENG-101"));
    expect(text(html)).toContain(
      "Accepted at b7e21aa in round 1 of 3 · 2 checks · 1 review · normal risk",
    );
    expect(text(html)).toContain("Checks 2 passed");
    expect(text(html)).toContain("Reviews adversarial-review passed · 0 open findings");
    expect(text(html)).toContain("Rules No rules ran");
    expect(text(html)).toContain("Risk normal · Commit b7e21aa changes no high-risk path.");
    expect(html).not.toContain("data-closeout-blocker");
    expect(html).toContain("View verification details");
    expect(html).not.toContain('data-action="toggle-check"');
  });

  test("a failing check, an open P1 finding and a broken rule show above the folded details", () => {
    const html = section(issuePage(withOpenP1(withRuleResults(fullStatusFixture())), "ENG-100"));
    const blockers = [...html.matchAll(/<li data-closeout-blocker>(.*?)<\/li>/g)].map((match) =>
      text(match[1]!),
    );
    expect(blockers).toContain(
      "Failed unit retention.test.ts keeps rows under legal hold: expected 0 deletions, received 14",
    );
    expect(blockers).toContain(
      "Open P1 src/retention/job.ts:44 Rows under legal hold are deleted.",
    );
    expect(blockers).toContain("Rule broke api-contract waiting for approval");
    expect(text(html)).toContain("1 passed · 1 failed · failing unit");
    expect(text(html)).toContain("3 held · 2 broke");
    expect(text(html)).toContain("· 2 checks · 1 review ·");
    expect(text(html)).toContain("Reviews independent-review failed · 1 open finding");
  });

  test("a running verdict names its running checks", () => {
    const full = fullStatusFixture();
    const verdict = full.verdicts.find((entry) => entry.itemId === "ENG-101")!;
    verdict.decision = "running";
    verdict.attempts = undefined;
    verdict.checks[1] = { ...verdict.checks[1]!, state: "running" } as StatusCheck;
    const html = section(issuePage(full, "ENG-101"));
    expect(text(html)).toContain(`· running ${verdict.checks[1]!.id}`);
    expect(text(html)).toContain("1 passed · 1 running");
  });

  test("no verdict says Closeout hasn't run yet", () => {
    expect(text(section(issuePage(fullStatusFixture(), "ENG-102")))).toContain(
      "Closeout hasn't run yet.",
    );
  });

  test("the one disclosure holds the checks, findings, rules and risk card", () => {
    const html = issuePage(withRuleResults(fullStatusFixture()), "ENG-100", openedView());
    const shown = section(html);
    expect(shown).toContain('data-action="toggle-check"');
    expect(shown).toContain(">Repository rules</h2>");
    expect(shown).toContain('id="risk-heading"');
    expect(shown).toContain('data-link-ask="q-rule-100"');
    for (const gone of ["Review findings", "Rules", "Risk"])
      expect(html).not.toContain(`<section class="issue-fold" aria-label="${gone}"`);
  });
});
