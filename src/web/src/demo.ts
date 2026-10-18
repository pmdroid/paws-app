import type { StatusSnapshot } from "./contract";

const AT = "2026-10-09T22:15:00.000Z";
const AUDIT = { id: "approval-audit", name: "Audit log export" };

const DEMO: StatusSnapshot = {
  version: 1,
  source: "demo",
  generatedAt: AT,
  project: {
    name: "Platform",
    team: "ENG",
    repo: "acme/platform",
    workspace: "acme",
  },
  items: [
    item({
      id: "ENG-104",
      title: "Admin export UI",
      state: "queued",
      agent: "Gemini",
      assignee: "Aisha Khan",
      owner: "Aisha Khan",
      project: AUDIT,
      blockers: ["ENG-101", "ENG-102", "ENG-103"],
      attempts: 0,
      branch: "aisha/eng-104-admin-export-ui",
      runId: null,
      pr: null,
    }),
    item({
      id: "ENG-103",
      title: "Signed URL delivery",
      state: "awaiting_input",
      agent: "Claude",
      assignee: "Jonas Berg",
      owner: "Jonas Berg",
      project: AUDIT,
      blockers: ["ENG-99"],
      attempts: 0,
      branch: "jonas/eng-103-signed-url",
      runId: "r-103",
      pr: null,
    }),
    item({
      id: "ENG-102",
      title: "CSV / JSON formatters",
      state: "running",
      agent: "Gemini",
      assignee: "Aisha Khan",
      owner: "Aisha Khan",
      project: null,
      blockers: ["ENG-99"],
      attempts: 0,
      branch: "aisha/eng-102-formatters",
      runId: "r-102",
      pr: null,
    }),
    item({
      id: "ENG-101",
      title: "Export job worker",
      state: "merge_queue",
      agent: "Codex",
      assignee: "Jonas Berg",
      owner: "Jonas Berg",
      project: AUDIT,
      blockers: ["ENG-99"],
      attempts: 1,
      branch: "jonas/eng-101-export-job-worker",
      runId: "r-101",
      pr: 479,
    }),
    item({
      id: "ENG-100",
      title: "Retention policy enforcement job",
      state: "exhausted",
      agent: "Claude",
      assignee: "Jonas Berg",
      owner: "Jonas Berg",
      project: AUDIT,
      blockers: ["ENG-99"],
      attempts: 3,
      branch: "jonas/eng-100-retention-policy",
      runId: "r-100",
      pr: null,
    }),
    item({
      id: "ENG-99",
      title: "Audit event schema v2",
      state: "merged",
      agent: "Claude",
      assignee: "Jonas Berg",
      owner: "Jonas Berg",
      project: null,
      blockers: [],
      attempts: 1,
      branch: "jonas/eng-99-audit-event-schema",
      runId: "r-99",
      pr: 474,
    }),
  ],
  runs: [
    {
      id: "r-102",
      itemId: "ENG-102",
      state: "running",
      agent: "Gemini",
      reviewer: "Codex",
      startedAt: "2026-10-09T21:40:00.000Z",
      attempt: 0,
      summary: "Streaming CSV and JSON formatters. Typecheck is clean; unit tests are next.",
      activity: [
        {
          at: "2026-10-09T21:40:00.000Z",
          kind: "system",
          text: "ACP session started with Gemini.",
        },
        {
          at: "2026-10-09T21:48:00.000Z",
          kind: "thought",
          text: "Formatters must stream. Exports can pass a million rows.",
        },
        { at: "2026-10-09T21:55:00.000Z", kind: "tool", text: "edit packages/audit/format/csv.ts" },
        { at: "2026-10-09T22:08:00.000Z", kind: "ok", text: "typecheck: 0 errors" },
      ],
      links: [{ label: "Linear", href: "https://linear.app/acme/issue/ENG-102" }],
    },
    {
      id: "r-103",
      itemId: "ENG-103",
      state: "awaiting_input",
      agent: "Claude",
      reviewer: "Codex",
      startedAt: "2026-10-09T21:20:00.000Z",
      attempt: 0,
      summary: "Parked on Q-41. The presigned URL expiry is not in the issue.",
      activity: [
        {
          at: "2026-10-09T21:20:00.000Z",
          kind: "system",
          text: "ACP session started with Claude.",
        },
        { at: "2026-10-09T21:50:00.000Z", kind: "tool", text: "edit apps/api/exports/deliver.ts" },
        {
          at: "2026-10-09T22:01:00.000Z",
          kind: "elicitation",
          text: "ask_team → Q-41. Run parked until Linear gets an answer.",
        },
      ],
      links: [{ label: "Linear", href: "https://linear.app/acme/issue/ENG-103" }],
    },
    {
      id: "r-101",
      itemId: "ENG-101",
      state: "done",
      agent: "Codex",
      reviewer: "Claude",
      startedAt: "2026-10-09T19:10:00.000Z",
      attempt: 1,
      summary: "Closeout accepted on attempt 1. Pull request is in the merge queue.",
      activity: [
        {
          at: "2026-10-09T20:55:00.000Z",
          kind: "ok",
          text: "Closeout beforePR accepted (attempt 1).",
        },
        { at: "2026-10-09T21:05:00.000Z", kind: "action", text: "Opened PR #479." },
      ],
      links: [
        { label: "Linear", href: "https://linear.app/acme/issue/ENG-101" },
        { label: "PR #479", href: "https://github.com/acme/platform/pull/479" },
      ],
    },
    {
      id: "r-100",
      itemId: "ENG-100",
      state: "done",
      agent: "Claude",
      reviewer: "Codex",
      startedAt: "2026-10-09T18:30:00.000Z",
      attempt: 3,
      summary: "Closeout requirement unit failed three times. The item is exhausted.",
      activity: [
        {
          at: "2026-10-09T20:40:00.000Z",
          kind: "err",
          text: "unit failed: retention.test.ts keeps rows under legal hold (expected 0, received 14).",
        },
        {
          at: "2026-10-09T20:40:30.000Z",
          kind: "elicitation",
          text: "Escalated to the team as Q-40.",
        },
      ],
      links: [{ label: "Linear", href: "https://linear.app/acme/issue/ENG-100" }],
    },
    {
      id: "r-99",
      itemId: "ENG-99",
      state: "done",
      agent: "Claude",
      reviewer: "Codex",
      startedAt: "2026-10-09T16:00:00.000Z",
      attempt: 1,
      summary: "Merged PR #474 into main.",
      activity: [{ at: "2026-10-09T20:15:00.000Z", kind: "ok", text: "Merged PR #474 into main." }],
      links: [
        { label: "Linear", href: "https://linear.app/acme/issue/ENG-99" },
        { label: "PR #474", href: "https://github.com/acme/platform/pull/474" },
      ],
    },
  ],
  questions: [
    {
      id: "Q-41",
      itemId: "ENG-103",
      runId: "r-103",
      title: "How long should export download links stay valid?",
      body: "The presigned URL needs an expiry. The epic only says “secure download link”.",
      context: "apps/api/exports/deliver.ts\nexpiresIn: /* ??? seconds */",
      kind: "decision",
      urgency: "blocking",
      options: ["15 minutes", "24 hours", "7 days (max for SigV4)"],
      recommendedOption: 1,
      askedAt: "2026-10-09T22:01:00.000Z",
      claimedBy: "Jonas Berg",
      links: [{ label: "Answer in Linear", href: "https://linear.app/acme/issue/ENG-103" }],
    },
    {
      id: "Q-40",
      itemId: "ENG-100",
      runId: "r-100",
      title: "Closeout requirement unit exhausted (3/3)",
      body: "The same legal-hold test failed three times. Closeout stopped further attempts on this task.",
      context: "FAIL retention.test.ts\nexpected deletions: 0\nreceived deletions: 14",
      kind: "exhausted",
      urgency: "blocking",
      options: [
        "Give guidance and retry with a new task id",
        "Reassign to Codex",
        "Take over manually",
        "Cancel the item",
      ],
      recommendedOption: 0,
      askedAt: "2026-10-09T20:40:00.000Z",
      claimedBy: null,
      links: [{ label: "Answer in Linear", href: "https://linear.app/acme/issue/ENG-100" }],
    },
  ],
  verdicts: [
    {
      itemId: "ENG-101",
      decision: "accepted",
      attempt: 1,
      maxAttempts: 3,
      summary: "All applicable requirements passed on a fresh head. Report is sealed.",
      failingCheck: null,
      baseSha: "a1c9e07",
      headSha: "b7e21aa",
      sealed: true,
      checks: [
        ran(check("typecheck", "command", "passed", "bun run typecheck", null), {
          elapsedMs: 8_400,
          exitCode: 0,
          stdout: "$ tsc --noEmit\n\u001b[32m✓\u001b[0m no type errors\n",
        }),
        ran(check("unit", "command", "passed", "bun test", null), {
          elapsedMs: 21_300,
          exitCode: 0,
          stdout:
            "bun test v1.4.2\n\n\u001b[32m✓\u001b[0m export worker > writes a manifest \u001b[2m[12ms]\u001b[0m\n\u001b[32m✓\u001b[0m export worker > retries a failed upload \u001b[2m[30ms]\u001b[0m\n\n \u001b[1m\u001b[32m48 pass\u001b[0m\n 0 fail\n",
        }),
        check(
          "adversarial-review",
          "review",
          "passed",
          "reviewer Codex, different session",
          "0 findings at P1",
        ),
      ],
      links: [
        { label: "Linear", href: "https://linear.app/acme/issue/ENG-101" },
        { label: "PR #479", href: "https://github.com/acme/platform/pull/479" },
      ],
    },
    {
      itemId: "ENG-100",
      decision: "exhausted",
      attempt: 3,
      maxAttempts: 3,
      summary: "Retry budget for this task is used up. A person decides what happens next.",
      failingCheck: "unit",
      baseSha: "a1c9e07",
      headSha: "91fd0c4",
      sealed: false,
      checks: retentionChecks(3),
      attempts: [1, 2, 3].map((number) => ({
        number,
        decision: number === 3 ? ("exhausted" as const) : ("rejected" as const),
        startedAt: `2026-10-09T${18 + number}:${number === 3 ? "38" : "10"}:00.000Z`,
        baseSha: "a1c9e07",
        headSha: ["4d02b1e", "6ae7f93", "91fd0c4"][number - 1]!,
        policyDigest: null,
        checks: retentionChecks(number),
      })),
      links: [{ label: "Linear", href: "https://linear.app/acme/issue/ENG-100" }],
      skipRequest: {
        checkIds: ["unit"],
        reason:
          "The retention test depends on the nightly fixture, which is down. The video shows the purge job deleting the expected rows.",
        href: "https://linear.app/acme/issue/ENG-100",
      },
    },
  ],
  mergeQueue: [
    {
      position: 1,
      itemId: "ENG-101",
      enqueuedAt: "2026-10-09T21:05:00.000Z",
      steps: [
        { name: "Rebase onto main", state: "run", detail: "a1c9e07 → main" },
        { name: "Re-run Closeout", state: "wait", detail: "evidence goes stale after a rebase" },
        { name: "Required check closeout-verified", state: "wait", detail: null },
        { name: "Squash merge", state: "wait", detail: null },
      ],
    },
  ],
  events: [
    {
      at: "2026-10-09T21:10:00.000Z",
      level: "warn",
      text: "Q-40 is still open. DRI Jonas was pinged.",
    },
    {
      at: "2026-10-09T21:05:00.000Z",
      level: "ok",
      text: "ENG-101 accepted by Closeout and entered the merge queue.",
    },
    { at: "2026-10-09T22:01:00.000Z", level: "warn", text: "ENG-103 asked the team Q-41." },
    { at: "2026-10-09T20:15:00.000Z", level: "ok", text: "ENG-99 merged (PR #474)." },
  ],
};

export function demoStatus(): StatusSnapshot {
  return structuredClone(DEMO);
}

function item(input: {
  id: string;
  title: string;
  state: StatusSnapshot["items"][number]["state"];
  agent: string;
  assignee: string;
  owner: string | null;
  project: { id: string; name: string } | null;
  blockers: string[];
  attempts: number;
  branch: string | null;
  runId: string | null;
  pr: number | null;
}): StatusSnapshot["items"][number] {
  const pr =
    input.pr === null
      ? null
      : { number: input.pr, url: `https://github.com/acme/platform/pull/${input.pr}` };
  return {
    id: input.id,
    title: input.title,
    state: input.state,
    agent: input.agent,
    assignee: input.assignee,
    owner: input.owner,
    project: input.project,
    blockers: input.blockers,
    attempts: input.attempts,
    branch: input.branch,
    runId: input.runId,
    pr,
    links: [
      { label: "Linear", href: `https://linear.app/acme/issue/${input.id}` },
      ...(pr === null ? [] : [{ label: `PR #${pr.number}`, href: pr.url }]),
    ],
  };
}

type DemoCheck = StatusSnapshot["verdicts"][number]["checks"][number];

function ran(base: DemoCheck, result: Partial<DemoCheck>): DemoCheck {
  return { ...base, attempt: 1, ...result };
}

function retentionChecks(attempt: number): DemoCheck[] {
  return [
    ran(check("typecheck", "command", "passed", "bun run typecheck", null), {
      attempt,
      elapsedMs: 7_900,
      exitCode: 0,
      stdout: "$ tsc --noEmit\n\u001b[32m✓\u001b[0m no type errors\n",
    }),
    ran(
      check(
        "unit",
        "command",
        "failed",
        "bun test",
        "retention.test.ts keeps rows under legal hold: expected 0 deletions, received 14",
      ),
      {
        attempt,
        elapsedMs: 18_200,
        exitCode: 1,
        stdout:
          "bun test v1.4.2\n\nretention.test.ts:\n\u001b[32m✓\u001b[0m retention > deletes expired rows \u001b[2m[9ms]\u001b[0m\n\u001b[31m✗\u001b[0m retention > keeps rows under legal hold \u001b[2m[14ms]\u001b[0m\n\n \u001b[1m\u001b[32m31 pass\u001b[0m\n \u001b[1m\u001b[31m1 fail\u001b[0m\n",
        stderr:
          "\u001b[1m\u001b[31merror\u001b[0m: expect(received).toBe(expected)\n\n  Expected: \u001b[32m0\u001b[0m\n  Received: \u001b[31m14\u001b[0m\n\n      at apps/api/retention.test.ts:58:31\n",
      },
    ),
  ];
}

function check(
  id: string,
  kind: StatusSnapshot["verdicts"][number]["checks"][number]["kind"],
  state: StatusSnapshot["verdicts"][number]["checks"][number]["state"],
  command: string,
  detail: string | null,
): StatusSnapshot["verdicts"][number]["checks"][number] {
  return { id, kind, state, command, detail };
}
