import { describe, expect, test } from "bun:test";
import type { StatusItem, StatusItemEvent } from "../contract";
import { fullStatusFixture, pageData, withRuleResults } from "../../test/fixtures";
import { emptyCloseoutView } from "./closeout";
import { journey, journeyStepper } from "./journey";
import { render } from "./render";

const event = (
  from: string,
  to: string,
  name: string,
  reason: string | null = null,
): StatusItemEvent => ({
  at: "2026-11-02T01:00:00.000Z",
  kind: name === "restart" ? "restart" : "transition",
  from,
  to,
  event: name,
  reason,
  actor: null,
});

function item(state: StatusItem["state"], timeline: StatusItemEvent[] = []): StatusItem {
  const base = fullStatusFixture().items.find((entry) => entry.id === "ENG-101")!;
  return { ...base, state, timeline, doing: undefined };
}

const accepted = [
  event("queued", "running", "dispatched"),
  event("running", "verifying", "turn_ended"),
  event("verifying", "merge_queue", "closeout_accepted"),
];

describe("issue journey", () => {
  test("a restart for a merge conflict reads as fixing merge conflicts, with the reason", () => {
    const value = journey(
      item("running", [
        ...accepted,
        event("merge_queue", "queued", "restart", "conflict"),
        event("queued", "running", "dispatched"),
      ]),
      undefined,
      undefined,
    );
    expect(value.step).toBe("fixing");
    expect(value.headline).toBe("Fixing merge conflicts");
    expect(value.reason).toContain("Main moved under this pull request");
    expect(value.pill).toEqual(["running", "Fixing merge conflicts"]);
  });

  test("Closeout findings read as fixing review comments until the agent's turn ends", () => {
    const fixing = item("running", [
      event("queued", "running", "dispatched"),
      event("running", "verifying", "turn_ended"),
      event("verifying", "queued", "restart", "findings"),
      event("queued", "running", "dispatched"),
    ]);
    expect(journey(fixing, undefined, undefined).headline).toBe("Fixing review comments");
    const checking = item("verifying", [
      ...fixing.timeline!,
      event("running", "verifying", "turn_ended"),
    ]);
    const value = journey(checking, undefined, undefined);
    expect(value.step).toBe("checking");
    expect(value.fixRounds).toBe(1);
  });

  test("an answer restarts implementation without a fix step", () => {
    const value = journey(
      item("running", [
        event("running", "awaiting_input", "blocking_question"),
        event("awaiting_input", "queued", "restart", "answer"),
        event("queued", "running", "dispatched"),
      ]),
      undefined,
      undefined,
    );
    expect(value.step).toBe("implementing");
    expect(journeyStepper(value)).not.toContain("Fix");
  });

  test("an exhausted Closeout waiting for a person sits on Checking as Needs you", () => {
    const value = journey(item("awaiting_input"), undefined, {
      attempt: 3,
      maxAttempts: 3,
      decision: "exhausted",
    });
    expect(value.step).toBe("checking");
    expect(value.tone).toBe("needs");
    expect(value.headline).toBe("Closeout exhausted");
  });

  test("a merge-queue re-check reads as Checking, not Waiting to merge", () => {
    const value = journey(item("merge_queue", accepted), undefined, {
      attempt: 2,
      maxAttempts: 3,
      decision: "running",
    });
    expect(value.step).toBe("checking");
    expect(value.reason).toBe("Closeout is verifying the work again before the merge.");
  });

  test("the stepper marks earlier steps done, the current one, and a past fix round", () => {
    const value = journey(
      item("merge_queue", [
        event("queued", "running", "dispatched"),
        event("running", "verifying", "turn_ended"),
        event("verifying", "queued", "restart", "ci"),
        event("queued", "running", "dispatched"),
        event("running", "verifying", "turn_ended"),
        event("verifying", "merge_queue", "closeout_accepted"),
      ]),
      undefined,
      undefined,
    );
    const html = journeyStepper(value, { queue: 2 });
    expect(html).toContain('<li class="run-step done">✓ Fixed · 1 round</li>');
    expect(html).toContain(
      '<li class="run-step now" aria-current="step">Waiting to merge · #2 in queue</li>',
    );
    expect(html).toContain('<li class="run-step wait">Done</li>');
  });
});

describe("issue page sections", () => {
  test("details start folded: Closeout shows its summary and no checks until opened", () => {
    const html = render({
      phase: "ready",
      error: null,
      engineUrl: null,
      closeout: emptyCloseoutView(),
      ...pageData(fullStatusFixture(), { view: "issues", id: "ENG-101" }),
    }).content;
    expect(html).toContain('aria-label="Issue progress"');
    expect(html).toContain("<h2>Closeout</h2>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-action="toggle-check"');
  });

  test("a section holding a decision opens by itself", () => {
    const snapshot = withRuleResults(fullStatusFixture());
    snapshot.questions.push({
      ...snapshot.questions[0]!,
      id: "q-rule",
      itemId: "ENG-100",
      linkAsk: {
        kind: "rule",
        head: "91fd0c4aa1",
        title: "A rule broke on 91fd0c4 and needs your decision.",
        detail: "Rule api-contract broke.",
        link: "https://paws.example/dashboard/issues/ENG-100#rule",
        bypass: { policyDigest: "sha256:0eadf4c1234", passed: [], checks: [] },
      },
    });
    const html = render({
      phase: "ready",
      error: null,
      engineUrl: null,
      closeout: emptyCloseoutView(),
      ...pageData(snapshot, { view: "issues", id: "ENG-100" }),
    }).content;
    const rules = html.slice(html.indexOf('aria-label="Rules"'));
    expect(rules).toContain('aria-expanded="true"');
    expect(rules).toContain("api-contract");
  });
});
