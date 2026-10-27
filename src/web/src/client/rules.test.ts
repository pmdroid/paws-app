import {
  FIXTURE_PROBE_SHA,
  fullStatusFixture,
  itemDetail,
  pageData,
  withRuleResults,
} from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { parseStatusItemDetail } from "../contract";
import { emptyCloseoutView, type CloseoutView } from "./closeout";
import { render } from "./render";
import { ruleResult } from "./rules";

function page(closeout: CloseoutView = emptyCloseoutView()): string {
  return render({
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout,
    ...pageData(withRuleResults(fullStatusFixture()), { view: "issues", id: "ENG-100" }),
  }).content;
}

/** The HTML of one rule row, from its opening tag to the next row. */
function row(html: string, id: string): string {
  const start = html.indexOf(`<div class="check-row rule-row" id="check-3-${id}">`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="check-row', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("repository rules on the run page", () => {
  test("the item detail carries rule rows through the contract", () => {
    const detail = itemDetail(withRuleResults(fullStatusFixture()), "ENG-100");
    const parsed = parseStatusItemDetail(JSON.parse(JSON.stringify(detail)));
    if (!parsed.ok) throw new Error(parsed.error);
    const attempt = parsed.detail.verdicts[0]!.attempts!.at(-1)!;
    expect(attempt.checks.filter((check) => check.kind === "rule").map(ruleResult)).toEqual([
      { label: "Passed", tone: "passed" },
      { label: "Failed", tone: "failed" },
      { label: "Waiting for approval", tone: "warn" },
      { label: "Approved", tone: "passed" },
      { label: "Bypassed", tone: "warn" },
    ]);
    expect(attempt.skippedRules).toEqual(["runner-protocol-docs", "settings-copy"]);
    expect(attempt.checks[0]?.probeSha256).toBe(FIXTURE_PROBE_SHA);
  });

  test("rules have their own section, apart from the command checks and the review", () => {
    const html = page();
    const closeout = html.slice(
      html.indexOf('aria-label="Closeout"'),
      html.indexOf('class="closeout-section rules-section"'),
    );
    const checks = closeout.slice(closeout.indexOf('<div class="check-list">'));
    expect(checks).toContain('data-check="unit"');
    expect(checks).not.toContain("rule-row");
    expect(checks).not.toContain('data-check="api-contract"');
    // Approved and bypassed rules do not hold the attempt.
    expect(closeout).toContain(
      "restart-and-ask-from-loop, api-contract, unit did not pass on head 91fd0c4.",
    );
    const rules = html.slice(html.indexOf('class="closeout-section rules-section"'));
    expect(rules).toContain("Repository rules");
    expect(rules).toContain("1 of 5 passed");
    expect(rules).not.toContain('data-check="unit"');
  });

  test("each row shows the rule id, probe hash, exit code, duration and result", () => {
    const passed = row(page(), "migrations-append-only");
    expect(passed).toContain("migrations-append-only");
    expect(passed).toContain("probe 3f9a1c27e4b0");
    expect(passed).toContain("exit 0 · 0.6s");
    expect(passed).toContain("Passed");
    // A passing row starts closed.
    expect(passed).toContain('aria-expanded="false"');
  });

  test("a probe failure opens its output", () => {
    const failed = row(page(), "restart-and-ask-from-loop");
    expect(failed).toContain('aria-expanded="true"');
    expect(failed).toContain("exit 1 · 1.3s");
    expect(failed).toContain("applies closeout_rejected outside src/loop");
    expect(failed).toContain("P1 finding");
  });

  test("a rule waiting for approval has Approve and Send back with a reason", () => {
    const waiting = row(page(), "api-contract");
    expect(waiting).toContain("Waiting for approval");
    expect(waiting).toContain('data-link-ask="q-rule-100" data-rule="api-contract"');
    expect(waiting).toContain('<textarea id="rule-reason-q-rule-100-api-contract" name="reason"');
    expect(waiting).toContain('value="approve"');
    expect(waiting).toContain(">Approve</button>");
    expect(waiting).toContain('value="changes"');
    expect(waiting).toContain(">Send back</button>");
    expect(waiting).toContain("91fd0c4");
  });

  test("an approval and a bypass show who, why and the commit they cover", () => {
    const html = page();
    const approved = row(html, "runner-protocol-strict");
    expect(approved).toContain("Approved by <b>Ada Lovelace</b> for commit");
    expect(approved).toContain("91fd0c4");
    expect(approved).toContain("Runners on the last release ignore this event");
    const bypassed = row(html, "closeout-policy-digest");
    expect(bypassed).toContain("Bypassed by <b>Grace Hopper</b> for commit");
    expect(bypassed).toContain("The policy digest changes on purpose in this commit.");
    expect(bypassed).not.toContain("<form");
  });

  test("rules whose paths matched nothing are listed by name", () => {
    expect(page()).toContain(
      'Not run, no changed path matches:</span> <span class="mono">runner-protocol-docs</span>, <span class="mono">settings-copy</span>',
    );
  });

  test("an earlier attempt without rules has no rules section", () => {
    const closeout = emptyCloseoutView();
    closeout.attempt["ENG-100"] = 1;
    expect(page(closeout)).not.toContain("Repository rules");
  });
});
