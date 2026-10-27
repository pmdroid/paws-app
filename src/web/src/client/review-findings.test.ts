import { fullStatusFixture, itemDetail, type FullStatus } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseStatusItemDetail,
  type StatusItemDetail,
  type StatusReview,
  type StatusReviewFinding,
} from "../contract";
import { emptyCloseoutView, type CloseoutView } from "./closeout";
import { render } from "./render";
import { earlierRoundsKey } from "./review-findings";
import { themedMarkup } from "./theme";

function finding(
  severity: StatusReviewFinding["severity"],
  location: string,
  explanation: string,
  marks: Partial<Pick<StatusReviewFinding, "preExisting" | "blocking" | "since">> = {},
): StatusReviewFinding {
  return {
    severity,
    location,
    explanation,
    evidence: `${location} as the reviewer read it`,
    preExisting: false,
    blocking: false,
    since: null,
    ...marks,
  };
}

/** Two rounds of independent-review: the second blocks on a P1 and fixed the first's P2. */
const REVIEW: StatusReview = {
  id: "independent-review",
  rounds: [
    {
      attempt: 1,
      baseSha: "a1c9e07",
      headSha: "6ae7f93",
      failOn: "P1",
      findings: [
        finding("P1", "src/retention/job.ts:40", "Deletes rows before the export finishes", {
          blocking: true,
        }),
        finding("P2", "src/retention/policy.ts:12", "Window is off by one day"),
      ],
      fixed: [],
    },
    {
      attempt: 2,
      baseSha: "a1c9e07",
      headSha: "91fd0c4",
      failOn: "P1",
      findings: [
        finding("P1", "src/retention/job.ts:44", "Deletes rows before the export finishes", {
          blocking: true,
          since: "open",
        }),
        finding("P2", "src/retention/legacy.ts:7", "<script>alert(1)</script> in old code", {
          preExisting: true,
          since: "new",
        }),
      ],
      fixed: [finding("P2", "src/retention/policy.ts:12", "Window is off by one day")],
    },
  ],
};

function withReviews(): StatusItemDetail {
  const snapshot = fullStatusFixture();
  const verdict = snapshot.verdicts.find((entry) => entry.itemId === "ENG-100")!;
  verdict.reviews = [
    REVIEW,
    {
      id: "security-review",
      rounds: [
        {
          attempt: 1,
          baseSha: "a1c9e07",
          headSha: "91fd0c4",
          failOn: "P1",
          findings: [],
          fixed: [],
        },
      ],
    },
  ];
  return detailOf(snapshot);
}

/** The issue page's data as `GET /api/status/items/ENG-100` serves it. */
function detailOf(full: FullStatus): StatusItemDetail {
  const parsed = parseStatusItemDetail(JSON.parse(JSON.stringify(itemDetail(full, "ENG-100"))));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.detail;
}

function page(detail: StatusItemDetail, closeout: CloseoutView = emptyCloseoutView()): string {
  return render({
    route: { view: "issues", id: "ENG-100" },
    phase: "ready",
    snapshot: null,
    detail,
    error: null,
    engineUrl: null,
    closeout,
  }).content;
}

function findingHtml(html: string, location: string): string {
  const start = html.lastIndexOf('<li class="review-finding', html.indexOf(`>${location}</code>`));
  return html.slice(start, html.indexOf("</li>", start));
}

describe("review findings on the issue page", () => {
  test("marks the blocking P1, the pre-existing P2 and the finding fixed since the earlier round", () => {
    const html = page(withReviews());
    expect(html).toContain(">Review findings</h2>");
    expect(html).toContain("Round 2 · head 91fd0c4 · fails on P1 or worse");

    const blocking = findingHtml(html, "src/retention/job.ts:44");
    expect(blocking).toContain('class="review-finding finding-blocking"');
    expect(blocking).toContain("Blocked: meets failOn P1");
    expect(blocking).toContain("Still open since round 1");

    const old = findingHtml(html, "src/retention/legacy.ts:7");
    expect(old).toContain('class="review-finding finding-pre-existing"');
    expect(old).toContain("Pre-existing, does not block");
    expect(old).toContain("New in round 2");
    expect(old).not.toContain("Blocked");

    const fixed = findingHtml(html, "src/retention/policy.ts:12");
    expect(fixed).toContain('class="review-finding finding-fixed"');
    expect(fixed).toContain("Fixed since round 1");
    expect(fixed).not.toContain("Blocked");

    expect(html).toContain("No findings.");
  });

  test("escapes finding text, which is model output", () => {
    const html = page(withReviews());
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; in old code");
  });

  test("keeps earlier rounds behind a disclosure until it is opened", () => {
    const snapshot = withReviews();
    const closed = page(snapshot);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("Show earlier rounds (1)");
    expect(closed).not.toContain("src/retention/job.ts:40");

    const view = emptyCloseoutView();
    view.open[earlierRoundsKey("ENG-100", "independent-review")] = true;
    const open = page(snapshot, view);
    expect(open).toContain("Hide earlier rounds (1)");
    expect(open).toContain("Round 1 · head 6ae7f93 · fails on P1 or worse");
    const first = findingHtml(open, "src/retention/job.ts:40");
    expect(first).toContain("Blocked: meets failOn P1");
    expect(first).not.toContain("since round");
  });

  test("an item without stored reviews has no findings section", () => {
    expect(page(detailOf(fullStatusFixture()))).not.toContain("Review findings");
  });

  test("390 px: long locations and evidence wrap instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, themedMarkup(page(withReviews()))),
    );
    expect(html).toContain("review-location");
    // Tailwind's `fixed` utility would pull a fixed finding out of the list.
    expect(html).not.toMatch(/class="(?:[^"]*\s)?fixed(?:\s[^"]*)?"/);
    expect(html).not.toMatch(/class="[^"]*review-finding[^"]*whitespace-nowrap/);
  });
});
