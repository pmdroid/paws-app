import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusEvidence, StatusSnapshot, StatusVisualReview } from "../contract";
import { demoStatus } from "../demo";
import { render } from "./render";
import { themedMarkup } from "./theme";

const NOW = "2026-10-23T10:00:00.000Z";
const LINK = "https://linear.app/acme/issue/ENG-7/settings#agent-session";

function shot(id: string, commit: string): StatusEvidence {
  return {
    id,
    itemId: "",
    runId: "",
    checkId: "visual-proof",
    attempt: 1,
    kind: "image",
    mediaType: "image/png",
    displayName: `${id}.png`,
    sizeBytes: 2048,
    headCommit: commit,
    publishedAt: "2026-10-23T09:00:00.000Z",
    publisher: "Claude",
  };
}

function round(patch: Partial<StatusVisualReview>): StatusVisualReview {
  return {
    questionId: "q-1",
    checkId: "visual-proof",
    round: 1,
    state: "waiting",
    evidenceIds: ["shot-1"],
    commit: "a".repeat(40),
    askedAt: "2026-10-23T09:00:00.000Z",
    answeredBy: null,
    answeredAt: null,
    feedback: null,
    ...patch,
  };
}

const CHANGES = round({
  state: "changes_requested",
  answeredBy: "Ada Reviewer",
  answeredAt: "2026-10-23T09:10:00.000Z",
  feedback: "Make the save button blue and align the labels.",
});

function fixture(
  reviews: StatusVisualReview[],
  state: "awaiting_input" | "running" | "verifying",
): { snapshot: StatusSnapshot; runId: string } {
  const snapshot = demoStatus();
  snapshot.generatedAt = NOW;
  const run = snapshot.runs[0]!;
  const item = snapshot.items.find((entry) => entry.id === run.itemId)!;
  item.state = state;
  item.owner = "Ada Reviewer";
  item.visualReviews = reviews;
  run.state = state === "awaiting_input" ? "awaiting_input" : "running";
  snapshot.verdicts = snapshot.verdicts.filter((verdict) => verdict.itemId !== item.id);
  snapshot.agentCloseout = [];
  snapshot.evidence = [shot("shot-1", "a".repeat(40)), shot("shot-2", "b".repeat(40))].map(
    (entry) => ({ ...entry, itemId: item.id, runId: run.id }),
  );
  snapshot.questions = reviews.some((review) => review.state === "waiting")
    ? [
        {
          id: reviews.at(-1)!.questionId,
          itemId: item.id,
          runId: run.id,
          title: "Visual review: accept, or describe the changes you want.",
          body: "Visual review: accept, or describe the changes you want.",
          context: "",
          kind: "decision",
          urgency: "blocking",
          options: ["Accept", "Request changes"],
          recommendedOption: null,
          askedAt: NOW,
          claimedBy: null,
          links: [{ label: "Answer in Linear", href: LINK }],
        },
      ]
    : [];
  return { snapshot, runId: run.id };
}

function runPage(snapshot: StatusSnapshot, runId: string): string {
  return render({
    route: { view: "runs", id: runId },
    phase: "ready",
    snapshot,
    via: "engine",
    error: null,
    engineUrl: null,
  }).content;
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}

function steps(html: string): string[] {
  return [...html.matchAll(/<li class="run-step ([a-z]+)"[^>]*>([^<]*)<\/li>/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

const waiting = () => fixture([round({})], "awaiting_input");
const accepted = () =>
  fixture(
    [
      CHANGES,
      round({
        questionId: "q-2",
        round: 2,
        state: "accepted",
        evidenceIds: ["shot-2"],
        commit: "b".repeat(40),
        answeredBy: "Ada Reviewer",
        answeredAt: "2026-10-23T09:40:00.000Z",
      }),
    ],
    "verifying",
  );
const changes = () => fixture([CHANGES], "running");

describe("visual review on the run page", () => {
  test("desktop, waiting: a Visual review step with its round, the pill and an Answer in Linear link", () => {
    const { snapshot, runId } = waiting();
    const html = runPage(snapshot, runId);
    expect(steps(html)).toEqual([
      "done ✓ Implementation",
      "now Visual review · round 1",
      "wait Closeout",
      "wait Waiting to merge",
      "wait Complete",
    ]);
    expect(html).toContain('class="run-stepper with-review"');
    expect(html).toContain('<span class="st awaiting_input">Waiting for visual review</span>');
    expect(html).toContain("Waiting for Ada Reviewer or the project lead · round 1");
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain("Answer in Linear");
    expect(html).toContain("shot-1.png · Sent to Linear");
    expect(html.match(/Visual review: accept, or describe/g)).toBeNull();
  });

  test("desktop, accepted: who accepted, when, every round's feedback and the commit that addressed it", () => {
    const { snapshot, runId } = accepted();
    const html = runPage(snapshot, runId);
    expect(steps(html)).toEqual([
      "done ✓ Implementation",
      "done ✓ Visual review",
      "now Closeout",
      "wait Waiting to merge",
      "wait Complete",
    ]);
    expect(html).toContain("Accepted by Ada Reviewer · 20m ago");
    expect(html).toContain("Ada Reviewer requested changes · 50m ago");
    expect(html).toContain("Make the save button blue and align the labels.");
    expect(html).toContain('Addressed in <span class="mono">bbbbbbb</span>, sent as round 2.');
    expect(html).toContain("shot-1.png · Superseded");
    expect(html).toContain("shot-2.png · Accepted");
    expect(html.indexOf("Round 2")).toBeLessThan(html.indexOf("Round 1"));
    expect(html).not.toContain("Waiting for visual review");
  });

  test("desktop, changes requested: the agent works on the feedback and the review step waits", () => {
    const { snapshot, runId } = changes();
    const html = runPage(snapshot, runId);
    expect(steps(html)).toEqual([
      "now Implementation",
      "wait Visual review",
      "wait Closeout",
      "wait Waiting to merge",
      "wait Complete",
    ]);
    expect(html).toContain('<span class="tag bad">Changes requested</span>');
    expect(html).toContain("The agent is addressing these changes.");
    expect(html).toContain("shot-1.png · Superseded");
  });

  test("waiting: the run page holds the drawing entry for the open question", () => {
    const { snapshot, runId } = waiting();
    expect(runPage(snapshot, runId)).toContain(
      '<div id="review-draw" data-question="q-1" hidden></div>',
    );
    const { snapshot: done, runId: doneRun } = changes();
    expect(runPage(done, doneRun)).not.toContain('id="review-draw"');
  });

  test("changes requested with marks: each marked screenshot shows next to its original", () => {
    const { snapshot, runId } = fixture(
      [{ ...CHANGES, marks: [{ id: "mark-1", evidenceId: "shot-1" }] }],
      "running",
    );
    const html = runPage(snapshot, runId);
    expect(html).toContain('href="/api/evidence/mark-1"');
    expect(html).toContain('alt="Marked shot-1.png"');
    expect(html).toContain("shot-1.png · Marked by the reviewer");
    expect(html.indexOf("shot-1.png · Superseded")).toBeLessThan(
      html.indexOf("shot-1.png · Marked by the reviewer"),
    );
  });

  test("a run without a visual review keeps its four steps", () => {
    const { snapshot, runId } = fixture([], "running");
    const html = runPage(snapshot, runId);
    expect(steps(html)).toHaveLength(4);
    expect(html).not.toContain("visual-review");
  });

  test("390 px: every state wraps and breaks instead of widening the page", () => {
    for (const { snapshot, runId } of [waiting(), accepted(), changes()]) {
      const html = renderToStaticMarkup(<>{themedMarkup(runPage(snapshot, runId))}</>);
      expect(classNames(html, "visual-review")[0]).toContain("min-w-0");
      expect(classNames(html, "visual-review-round").length).toBeGreaterThan(0);
      for (const value of classNames(html, "row")) expect(value).toContain("flex-wrap");
      for (const value of classNames(html, "ctx")) expect(value).toContain("break-words");
    }
    const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 500px)"));
    expect(phone).toMatch(
      /\.run-stepper,\s*\.run-stepper\.with-review \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(css).toContain(".evidence-more {\n  display: grid;");
  });
});
