import { statusFixture } from "../../test/fixtures";
import { expect, test } from "bun:test";
import { bypassLabel } from "./link-ask";
import { render, type RenderModel } from "./render";

function withLinkAsk() {
  const snapshot = statusFixture();
  snapshot.questions[0]!.linkAsk = {
    kind: "bypass",
    head: "7f65200aa1",
    title: "Closeout needs your decision on 7f65200.",
    detail: "independent-review failed (P1, docs/smoke-test.md). 7 other checks passed.",
    link: "https://paws.example/status/issues/ENG-103#closeout",
  };
  return snapshot;
}

function model(patch: Partial<RenderModel>): RenderModel {
  return {
    route: { view: "overview" },
    phase: "ready",
    snapshot: withLinkAsk(),
    error: null,
    engineUrl: null,
    ...patch,
  };
}

test("Needs you shows a link ask with its kind's button, linking to the card", () => {
  const html = render(model({})).content;
  expect(html).toContain('href="/issues/ENG-103#closeout"');
  expect(html).toContain("Review bypass</a>");
  expect(html).toContain("independent-review failed (P1, docs/smoke-test.md).");
  expect(html).not.toContain('href="/questions/Q-41"');
});

test("the item page shows the card with a decision form and no Linear answer", () => {
  const html = render(model({ route: { view: "issues", id: "ENG-103" } })).content;
  expect(html).toContain('id="closeout"');
  expect(html).toContain('data-link-ask="Q-41"');
  expect(html).toContain('value="approve"');
  expect(html).toContain('value="changes"');
  expect(html).toContain("7f65200");
  expect(html).toContain("A reply in Linear only sends the agent guidance.");
});

test("a question kind is answered in words, not approved", () => {
  const snapshot = withLinkAsk();
  snapshot.questions[0]!.linkAsk!.kind = "question";
  const page = render(model({ snapshot, route: { view: "issues", id: "ENG-103" } })).content;
  expect(page).toContain('value="answer"');
  expect(page).not.toContain('value="approve"');
  expect(render(model({ snapshot })).content).toContain('href="/issues/ENG-103#question"');
});

function withBypass() {
  const snapshot = withLinkAsk();
  snapshot.questions[0]!.linkAsk!.bypass = {
    policyDigest: "sha256:0eadf4c9d2e1",
    passed: ["install", "lint", "test"],
    checks: [
      {
        id: "independent-review",
        kind: "review",
        state: "failed",
        attempt: 1,
        finding:
          "docs/smoke-test.md: Recorded runs\nThe required live smoke runs remain incomplete.",
      },
    ],
  };
  return snapshot;
}

test("the bypass card lists each failed check with its finding, a checkbox and a reason", () => {
  const html = render(
    model({ snapshot: withBypass(), route: { view: "issues", id: "ENG-103" } }),
  ).content;
  expect(html).toContain("Closeout needs your help");
  expect(html).toContain('id="closeout"');
  expect(html).toContain('data-bypass="7f65200aa1"');
  expect(html).toContain('name="check" value="independent-review" checked=""');
  expect(html).toContain("attempt 1 · review");
  expect(html).toContain("The required live smoke runs remain incomplete.");
  expect(html).toContain('name="reason" data-check="independent-review"');
  expect(html).toContain("Saved with your name in Audit history and in the pull request body.");
  expect(html).toContain("Bypass 1 check for 7f65200 and re-verify");
  expect(html).toContain("Send guidance instead");
  expect(html).toContain('data-link-ask-stop="ENG-103"');
  expect(html).toContain("install, lint, test");
  expect(html).toContain("sha256:0eadf4c</span> only. A new commit runs every check again.");
  expect(html).toContain("A reply in Linear never bypasses a check.");
});

test("with several failed checks none starts selected and the bypass button waits", () => {
  const snapshot = withBypass();
  const bypass = snapshot.questions[0]!.linkAsk!.bypass!;
  bypass.checks.push({ id: "test", kind: "command", state: "exhausted", attempt: 3, finding: "" });
  const html = render(model({ snapshot, route: { view: "issues", id: "ENG-103" } })).content;
  expect(html).not.toContain('checked=""');
  expect(html).toContain('data-bypass-submit="" disabled=""');
  expect(html).toContain("Bypass 0 checks for 7f65200 and re-verify");
  expect(html).toContain("Out of attempts");
  expect(bypassLabel(2, "7f65200aa1")).toBe("Bypass 2 checks for 7f65200 and re-verify");
});
