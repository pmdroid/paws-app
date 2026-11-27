import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderSplitSettings } from "./split-settings";

const data = { enabled: true, maxSubIssues: 2, approvalsBeforeAuto: 3, approvedSplits: 1 };
const view = { data, busy: null, error: null, saved: false };

const parse = (html: string) => {
  const doc = new Window().document;
  doc.body.innerHTML = html;
  return doc;
};

test("an admin edits the toggle and both ranges and sees the trust ramp", () => {
  const doc = parse(renderSplitSettings(view, true));
  expect(doc.querySelectorAll("input:disabled").length).toBe(0);
  expect(doc.querySelector("#split-max-sub-issues-help")?.textContent).toBe("From 1 to 5.");
  expect(doc.querySelector("#split-approvals-help")?.textContent).toBe("From 0 to 10.");
  expect(doc.querySelector("#split-progress")?.textContent).toBe(
    "1 approved split so far; splits are automatic after 3.",
  );
  expect(doc.querySelector('button[type="submit"]')).not.toBeNull();
});

test("a member sees the values read-only and the route's error shows", () => {
  const doc = parse(
    renderSplitSettings(
      { ...view, error: "splits.maxSubIssues must be a whole number from 1 to 5" },
      false,
    ),
  );
  expect(doc.querySelectorAll("input:disabled").length).toBe(3);
  expect(doc.querySelector('button[type="submit"]')).toBeNull();
  expect(doc.querySelector('[role="alert"]')?.textContent).toBe(
    "splits.maxSubIssues must be a whole number from 1 to 5",
  );
});
