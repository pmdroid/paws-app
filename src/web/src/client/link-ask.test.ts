import { statusFixture } from "../../test/fixtures";
import { expect, test } from "bun:test";
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
