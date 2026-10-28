import { expect, test } from "bun:test";
import { applyLinearCommand, insertQueuedItem, listOutbox, saveOpenFindings } from "../src/db";
import {
  inertMarkdown,
  openFindingsLine,
  openFindingsSection,
  pawsIssueUrl,
  type OpenFinding,
} from "../src/loop";
import { tempDb } from "./helpers";

const P1: OpenFinding = {
  reviewId: "independent-review",
  severity: "P1",
  location: "src/a.ts:12",
  explanation: "Reads the token\n  before the check.",
  why: "pre-existing",
};

const P2: OpenFinding = {
  reviewId: "security-review",
  severity: "P2",
  location: "src/b.ts:3",
  explanation: "Logs the request.",
  why: "below failOn",
};

const LINK = "https://paws.example/status/issues/PAS-1";

test("the line counts open findings by severity and why, names high risk and links the page", () => {
  expect(
    openFindingsLine({
      findings: [P2, P1],
      risk: { tier: "high", paths: ["src/auth/x.ts"] },
      link: LINK,
    }),
  ).toBe(
    `2 findings still open (1 P1 pre-existing, 1 P2 below failOn) and risk high (\`src/auth/x.ts\`). Check them: ${LINK}`,
  );
  expect(
    openFindingsLine({ findings: [], risk: { tier: "high", paths: ["a.ts"] }, link: null }),
  ).toBe("No findings still open, and risk high (`a.ts`). Check them on the Paws dashboard.");
  expect(openFindingsLine({ findings: [], risk: { tier: "normal", paths: [] }, link: LINK })).toBe(
    "",
  );
  expect(openFindingsLine({ findings: [], risk: null, link: LINK })).toBe("");
});

test("the section lists one line per finding, most severe first", () => {
  expect(openFindingsSection({ findings: [P2, P1], risk: null, link: LINK })).toBe(
    [
      "## Open findings",
      `2 findings still open (1 P1 pre-existing, 1 P2 below failOn). Check them: ${LINK}`,
      [
        "- P1 `src/a.ts:12` Reads the token before the check. (independent-review, pre-existing)",
        "- P2 `src/b.ts:3` Logs the request. (security-review, below failOn)",
      ].join("\n"),
    ].join("\n\n"),
  );
  expect(
    openFindingsSection({ findings: [], risk: { tier: "normal", paths: [] }, link: LINK }),
  ).toBe("");
});

test("finding text is cut to one line", () => {
  const long = { ...P2, explanation: "x".repeat(400) };
  const line = openFindingsSection({ findings: [long], risk: null, link: null })
    .split("\n")
    .at(-1)!;
  expect(line).toContain(`${"x".repeat(159)}…`);
  expect(line).not.toContain("x".repeat(160));
});

test("mentions, links, HTML, references and bare URLs in finding text come out inert", () => {
  const text = inertMarkdown(
    "@octocat [link](x) ![img](y) <b>bold</b> &lt;i&gt; *em* _u_ #12 https://evil.example www.evil.example `code` a|b",
  );
  expect(text).not.toMatch(/@\w/);
  expect(text).not.toMatch(/(^|[^\\])[[\]<>*_`|!&]/);
  expect(text).not.toContain("://");
  expect(text).not.toMatch(/www\./);
  expect(text).not.toMatch(/#\d/);
  const location = openFindingsSection({
    findings: [{ ...P1, location: "a`b.ts:1" }],
    risk: null,
    link: null,
  });
  expect(location).toContain("``a`b.ts:1``");
});

test("the Paws link needs a public URL", () => {
  const item = { id: "item", linearIdentifier: "PAS-1" } as Parameters<typeof pawsIssueUrl>[1];
  expect(pawsIssueUrl("https://paws.example//", item)).toBe(LINK);
  expect(pawsIssueUrl(null, item)).toBeNull();
  expect(pawsIssueUrl("  ", item)).toBeNull();
});

test("the stopped and closed responses carry the open findings of the last published head", () => {
  const db = tempDb();
  try {
    for (const [id, response] of [
      ["stopped", undefined],
      ["closed", "Closed: the issue was canceled in Linear."],
    ] as const) {
      insertQueuedItem(db, { id, sessionKey: `session-${id}`, now: 1 });
      saveOpenFindings(db, {
        itemId: id,
        head: "a".repeat(40),
        line: "1 finding still open.",
        now: 2,
      });
      expect(
        applyLinearCommand(
          db,
          { type: "stop", source: "linear", itemId: id, requestedAt: 5 },
          5,
          response,
        ).applied,
      ).toBe(true);
      const body = listOutbox(db)
        .filter((row) => row.orderingKey === `session-${id}` && row.op === "activity")
        .map((row) => (row.payload as { body: string }).body)
        .at(-1);
      expect(body).toEndWith("\n\n1 finding still open.");
    }
  } finally {
    db.close();
  }
});
