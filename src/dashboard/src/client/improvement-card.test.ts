import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { DEFAULT_IMPROVEMENT_FILTER, type ImprovementDetail } from "../improvements";
import { renderImprovements, type ImprovementsView } from "./improvements";

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 3);

const detail: ImprovementDetail = {
  item: {
    id: "imp-retro",
    version: 1,
    sourceKind: "retro_item",
    repository: "acme/a",
    lifecycle: "needs_review",
    reviewState: "needs_review",
    proposal: {
      title: "Agents skip the affected-tests script",
      problem: "4 of 11 runs ran the full suite inside Closeout.",
      proposedChange: "Point the agent brief at scripts/affected-tests.ts.",
      actionStep: "convention",
      verificationCriterion: "No Closeout time-outs on test next week.",
      evidence: ["retro:r1:e0", "retro:r1:e1"],
      version: 1,
      source: { kind: "retro_item", key: "r1:p1" },
      createdAt: START,
    },
    criterion: "No Closeout time-outs on test next week.",
    decision: {
      proposalVersion: null,
      intent: null,
      intentIssueId: null,
      evidenceComment: false,
      reason: null,
      by: null,
      at: null,
    },
    issue: null,
    legacy: [],
    deliveries: [],
    implementation: "unknown",
    verification: "unknown",
  },
  proposals: [],
  decisions: [],
  criteria: [],
  evidence: [0, 6].map((offset, index) => ({
    kind: "retro_evidence" as const,
    ref: `retro:r1:e${index}`,
    retroId: "r1",
    repository: "acme/a",
    sourceKind: "session",
    occurredAt: START + offset * DAY,
    excerpt: "Ran bun test without a filter.",
  })),
  destinations: ["team-a"],
  candidates: [],
};

function view(): ImprovementsView {
  return {
    tab: "review",
    id: detail.item.id,
    filter: DEFAULT_IMPROVEMENT_FILTER,
    list: null,
    listError: null,
    attention: null,
    detail,
    follow: null,
    detailState: "ready",
    detailError: null,
    schedule: null,
    daily: null,
    report: null,
    reportState: "loading",
    history: null,
    historyError: null,
    item: null,
    itemEvidence: null,
    itemEvidenceState: "idle",
    download: { file: null, error: null },
    expanded: false,
    choice: null,
    drafts: {},
    confirmClosed: null,
    busy: null,
    message: "",
    error: null,
    local: true,
    now: START + 7 * DAY,
  };
}

function render(change: Partial<ImprovementsView> = {}): Document {
  const document = new Window().document as unknown as Document;
  document.body.innerHTML = renderImprovements({ ...view(), ...change });
  return document;
}

test("a retro review card shows its four fields in one grid and its decision buttons in one row", () => {
  const document = render();
  const card = document.querySelector("[data-improvement='imp-retro']")!;
  const header = card.querySelector(".improvement-head")!;
  expect(header.querySelector(".st.verifying")?.textContent).toBe("weekly retro");
  expect(header.querySelector("#improvement-heading")?.textContent).toBe(
    "Agents skip the affected-tests script",
  );
  expect(header.querySelector(".improvement-period")?.textContent).toBe("2026-11-03 – 2026-11-09");

  const grids = card.querySelectorAll("[data-improvement-fields]");
  expect(grids).toHaveLength(1);
  const labels = [...grids[0]!.querySelectorAll(".improvement-label")].map((h) => h.textContent);
  expect(labels).toEqual(["Problem", "Intended change", "Evidence", "Verification criterion"]);
  expect(grids[0]!.querySelector("code")?.textContent).toBe("retro:r1:e0");

  const row = card.querySelector("[role='group'][aria-label='Decision']")!;
  const buttons = [...row.children].map((child) => [child.tagName, child.textContent]);
  expect(buttons).toEqual([
    ["BUTTON", "Create issue"],
    ["BUTTON", "Link existing issue"],
    ["BUTTON", "Reject"],
  ]);
  expect(
    grids[0]!.compareDocumentPosition(row) & 4 /* Node.DOCUMENT_POSITION_FOLLOWING */,
  ).toBeTruthy();
});

test("the improvement tabs are one segmented control with the review count on Review", () => {
  const counts = { newReview: 3, filingErrors: 0, needsAttention: 0, verificationDue: 0, total: 3 };
  const attention = { counts, items: [], activity: [] } as unknown as ImprovementsView["attention"];
  const nav = render({ attention }).querySelector("nav[aria-label='Improvement pages']")!;
  expect(nav.className).toBe("segmented");
  expect([...nav.querySelectorAll("a")].map((tab) => tab.textContent)).toEqual([
    "Review 3",
    "History",
    "Settings",
  ]);
  expect(nav.querySelector("[aria-current='page']")?.textContent).toBe("Review 3");
});

test("an empty Review tab says when improvements appear", () => {
  const list = { items: [], matching: 0, repositories: [], nextCursor: null } as unknown;
  const document = render({ id: null, detail: null, list: list as ImprovementsView["list"] });
  expect(document.querySelector(".improvement-list-pane")?.textContent).toBe(
    "Nothing to review. Daily findings and weekly retros appear here after some work has merged.",
  );
});
