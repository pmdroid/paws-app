import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  getSuggestionTurn,
  suggestedFindings,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  recordPullComment,
} from "../src/db";
import {
  openFindingsSection,
  parseFindingDecisions,
  recordAgentFindingDecisions,
  startSuggestionTurn,
  handSuggestions,
  withDecisions,
  type OpenFinding,
} from "../src/loop";
import { tempDb } from "./helpers";

const HOUR = 3_600_000;

function mergeQueueItem(id: string, awakeMs = 0) {
  const db = tempDb();
  insertQueuedItem(db, { id, sessionKey: `session-${id}`, now: 1, maxAwakeMs: 2 * HOUR });
  db.run("UPDATE work_item SET state = 'merge_queue', awake_ms = ? WHERE id = ?", [awakeMs, id]);
  return db;
}

function resumeJobs(db: ReturnType<typeof tempDb>, itemId: string) {
  return listJobs(db).filter(
    (job) =>
      job.queue === JOB_KIND.resume &&
      (job.payload as { itemId?: string }).itemId === itemId &&
      job.status === "pending",
  );
}

test("own_turn starts exactly one suggestion restart from merge_queue, and none for a second head", () => {
  const db = mergeQueueItem("acme-1");
  try {
    expect(
      startSuggestionTurn(db, { itemId: "acme-1", head: "a".repeat(40), suggestions: 1, now: 5 }),
    ).toBe("started");
    expect(getWorkItem(db, "acme-1")?.state).toBe("queued");
    expect(resumeJobs(db, "acme-1").map((job) => job.jobKey)).toEqual([
      "suggested-findings:acme-1",
    ]);
    db.run("UPDATE work_item SET state = 'merge_queue' WHERE id = 'acme-1'");
    expect(
      startSuggestionTurn(db, { itemId: "acme-1", head: "b".repeat(40), suggestions: 2, now: 9 }),
    ).toBe("none");
    expect(getSuggestionTurn(db, "acme-1")).toMatchObject({
      outcome: "started",
      head: "a".repeat(40),
    });
  } finally {
    db.close();
  }
});

test("own_turn starts nothing without suggestions or when another restart is already coming", () => {
  const db = mergeQueueItem("acme-2");
  try {
    expect(
      startSuggestionTurn(db, { itemId: "acme-2", head: "a".repeat(40), suggestions: 0, now: 5 }),
    ).toBe("none");
    expect(getSuggestionTurn(db, "acme-2")).toBeNull();
    recordPullComment(db, {
      itemId: "acme-2",
      pullNumber: 7,
      commentId: 11,
      source: "conversation",
      reviewId: null,
      author: "octocat",
      body: "Please rename this.",
      path: null,
      line: null,
      receivedAt: 4,
    });
    expect(
      startSuggestionTurn(db, { itemId: "acme-2", head: "a".repeat(40), suggestions: 1, now: 5 }),
    ).toBe("skipped");
    expect(getWorkItem(db, "acme-2")?.state).toBe("merge_queue");
    expect(resumeJobs(db, "acme-2")).toEqual([]);
  } finally {
    db.close();
  }
});

test("own_turn skips the suggestion restart under 45 minutes of awake budget and records why", () => {
  const db = mergeQueueItem("acme-3", 2 * HOUR - 44 * 60_000);
  try {
    expect(
      startSuggestionTurn(db, { itemId: "acme-3", head: "a".repeat(40), suggestions: 1, now: 5 }),
    ).toBe("skipped");
    expect(getWorkItem(db, "acme-3")?.state).toBe("merge_queue");
    expect(getSuggestionTurn(db, "acme-3")).toMatchObject({
      outcome: "skipped",
      reason: expect.stringContaining("44 minutes of the awake budget remain, under 45"),
    });
  } finally {
    db.close();
  }
});

test("decisions are read only from the Finding decisions lines of handed ids", () => {
  const handed = new Set(["F1a2b3c", "F4d5e6f"]);
  expect(
    parseFindingDecisions(
      [
        "I looked at both.",
        "F4d5e6f fixed: before the section, so ignored",
        "",
        "**Finding decisions**",
        "- **F1a2b3c** fixed: kept the grant's resource",
        "F4d5e6f declined: needs a schema change",
        "F999999 declined: not handed",
        "",
        "F1a2b3c is fine, I think",
        "F4d5e6f fixed: after the section, so ignored",
      ].join("\n"),
      handed,
    ),
  ).toEqual(
    new Map([
      ["F1a2b3c", { decision: "fixed", reason: "kept the grant's resource" }],
      ["F4d5e6f", { decision: "declined", reason: "needs a schema change" }],
    ]),
  );
});

test("each open finding line ends with its decision", () => {
  const finding: OpenFinding = {
    reviewId: "independent-review",
    severity: "P2",
    location: "src/grant.ts:40",
    explanation: "Swaps the stored resource.",
    why: "below failOn",
  };
  const section = openFindingsSection({
    findings: [
      {
        ...finding,
        decision: { decision: "declined", reason: "needs a schema change", head: null },
      },
      {
        ...finding,
        location: "src/meta.ts:9",
        decision: { decision: "fixed", reason: "guarded", head: "abc1234def" },
      },
    ],
    risk: null,
    link: null,
  });
  expect(section).toContain(
    "- P2 `src/grant.ts:40` Swaps the stored resource. (independent-review, below failOn; declined: needs a schema change)",
  );
  expect(section).toContain(
    "(independent-review, below failOn; fixed in abc1234, pending verification)",
  );
});

const GRANT: OpenFinding = {
  reviewId: "independent-review",
  severity: "P2",
  location: "src/grant.ts:40",
  explanation: "Swaps the stored resource.",
  why: "below failOn",
};
const META: OpenFinding = {
  ...GRANT,
  location: "src/meta.ts:9",
  explanation: "Rewrites the path.",
};

function handedItem(id: string) {
  const db = mergeQueueItem(id);
  handSuggestions(db, id, [GRANT, META], 5);
  const idAt = (location: string) =>
    suggestedFindings(db, id).find((record) => record.location === location)!.findingId;
  const grant = idAt(GRANT.location);
  const meta = idAt(META.location);
  return { db, grant, meta };
}

test("a fixed claim stays listed, pending verification, when the next review omits it", () => {
  const { db, grant, meta } = handedItem("acme-4");
  try {
    recordAgentFindingDecisions(
      db,
      "acme-4",
      `Finding decisions\n${grant} declined: needs a schema change\n${meta} fixed: kept the location`,
      "c".repeat(40),
      9,
    );
    const open = withDecisions([], suggestedFindings(db, "acme-4"));
    expect(open).toHaveLength(2);
    expect(open).toContainEqual(
      expect.objectContaining({
        location: "src/grant.ts:40",
        decision: { decision: "declined", reason: "needs a schema change", head: "c".repeat(40) },
      }),
    );
    expect(open).toContainEqual(
      expect.objectContaining({
        location: "src/meta.ts:9",
        decision: { decision: "fixed", reason: "kept the location", head: "c".repeat(40) },
      }),
    );
    const section = openFindingsSection({ findings: open, risk: null, link: null });
    expect(section).toContain(
      "(independent-review, below failOn; fixed in ccccccc, pending verification)",
    );
    const reported = withDecisions([GRANT, META], suggestedFindings(db, "acme-4"));
    expect(reported.map((finding) => finding.decision?.decision)).toEqual(["declined", "fixed"]);
  } finally {
    db.close();
  }
});

test("a fixed claim without a commit Paws confirmed, or in prose only, records nothing", () => {
  const { db, grant, meta } = handedItem("acme-5");
  try {
    expect(
      recordAgentFindingDecisions(db, "acme-5", `${grant} fixed: kept the resource`, null, 9),
    ).toBe(0);
    expect(
      recordAgentFindingDecisions(
        db,
        "acme-5",
        `I fixed ${meta} and ${grant}, both are fine now.`,
        "c".repeat(40),
        9,
      ),
    ).toBe(0);
    expect(suggestedFindings(db, "acme-5").every((record) => record.decision === null)).toBe(true);
    expect(withDecisions([GRANT, META], suggestedFindings(db, "acme-5"))).toEqual([GRANT, META]);
  } finally {
    db.close();
  }
});

test("quoted or unsectioned decision lines record nothing", () => {
  const handed = new Set(["F1a2b3c"]);
  expect(parseFindingDecisions("> F1a2b3c declined: needs a schema change", handed).size).toBe(0);
  expect(parseFindingDecisions("F1a2b3c declined: needs a schema change", handed).size).toBe(0);
  expect(
    parseFindingDecisions("Finding decisions\n> F1a2b3c declined: needs a schema change", handed)
      .size,
  ).toBe(0);
});

test("a decision belongs to its finding id, not to another finding at the same location", () => {
  const { db, grant } = handedItem("acme-6");
  try {
    recordAgentFindingDecisions(
      db,
      "acme-6",
      `Finding decisions\n${grant} declined: needs a schema change`,
      null,
      9,
    );
    const other: OpenFinding = { ...GRANT, explanation: "Drops the refresh token." };
    const open = withDecisions([other], suggestedFindings(db, "acme-6"));
    expect(open[0]).toEqual(other);
    expect(open[1]).toMatchObject({
      location: GRANT.location,
      explanation: GRANT.explanation,
      decision: { decision: "declined", reason: "needs a schema change" },
    });
  } finally {
    db.close();
  }
});

test("a declined finding keeps its line and reason when the next review omits it", () => {
  const { db, grant } = handedItem("acme-7");
  try {
    recordAgentFindingDecisions(
      db,
      "acme-7",
      `Finding decisions\n${grant} declined: needs a schema change`,
      null,
      9,
    );
    const section = openFindingsSection({
      findings: withDecisions([], suggestedFindings(db, "acme-7")),
      risk: null,
      link: null,
    });
    expect(section).toContain(
      "`src/grant.ts:40` Swaps the stored resource. (independent-review, below failOn; declined: needs a schema change)",
    );
  } finally {
    db.close();
  }
});
