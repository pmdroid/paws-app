// Test data for dashboard rendering. Never imported by production code.
import type { StatusItemEvent, StatusSnapshot } from "../src/contract";

const AT = "2026-10-09T22:15:00.000Z";
const AUDIT = { id: "linear-audit", name: "Audit log export" };

const FIXTURE: StatusSnapshot = {
  version: 1,
  source: "live",
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
      blockers: [],
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
      blockers: [],
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
      blockers: [],
      attempts: 1,
      branch: "jonas/eng-101-export-job-worker",
      runId: "r-101",
      pr: 479,
      timeline: [
        step("2026-10-09T20:58:00.000Z", "queued", "running", "dispatched"),
        step("2026-10-09T21:20:00.000Z", "running", "verifying", "turn_ended"),
        {
          ...step("2026-10-09T21:31:00.000Z", "verifying", "queued", "restart"),
          kind: "restart",
          reason: "findings",
        },
        step("2026-10-09T21:33:00.000Z", "queued", "running", "dispatched"),
        step("2026-10-09T21:52:00.000Z", "running", "verifying", "turn_ended"),
        step("2026-10-09T22:04:00.000Z", "verifying", "merge_queue", "closeout_accepted"),
      ],
    }),
    item({
      id: "ENG-100",
      title: "Retention policy enforcement job",
      state: "exhausted",
      agent: "Claude",
      assignee: "Jonas Berg",
      owner: "Jonas Berg",
      project: AUDIT,
      blockers: [],
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
      body: "The same legal-hold test failed three times. Closeout stopped further attempts on this item.",
      context: "FAIL retention.test.ts\nexpected deletions: 0\nreceived deletions: 14",
      kind: "exhausted",
      urgency: "blocking",
      options: [
        "Give guidance and retry with a new item id",
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
      summary: "Retry budget for this item is used up. A person decides what happens next.",
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
    },
  ],
  agentCloseout: [agentCloseout()],
  mergeQueue: [
    {
      position: 1,
      itemId: "ENG-101",
      repository: "acme/platform",
      enqueuedAt: "2026-10-09T21:05:00.000Z",
      acceptedAt: "2026-10-09T21:05:00.000Z",
      waitingFor: "ci",
      detail: "Branch updated onto main a1c9e07. CI 4 of 6 checks done.",
      settings: { order: "queue", mainMoved: "ci", rule: null },
      steps: [
        { name: "Rebase onto main", state: "run", detail: "a1c9e07 → main" },
        { name: "Re-run Closeout", state: "wait", detail: "evidence goes stale after a rebase" },
        { name: "Required check closeout-verified", state: "wait", detail: null },
        { name: "Squash merge", state: "wait", detail: null },
      ],
    },
  ],
  mergeHistory: [
    {
      itemId: "ENG-99",
      repository: "acme/platform",
      outcome: "merged",
      reason: null,
      at: "2026-10-09T20:15:00.000Z",
      settings: { order: "queue", mainMoved: "ci", rule: null },
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

function agentCloseout(): NonNullable<StatusSnapshot["agentCloseout"]>[number] {
  const passed = (
    id: string,
    kind: "setup" | "command",
    command: string,
    elapsedMs: number,
    stdout: string,
  ) =>
    ran(check(id, kind, "passed", command, null), { attempt: 1, elapsedMs, exitCode: 0, stdout });
  const setup = [
    passed(
      "install",
      "setup",
      "bun install --frozen-lockfile",
      4_200,
      "bun install v1.4.2\n\nChecked 230 installs across 241 packages (no changes) [412.00ms]\n",
    ),
    passed("lint", "command", "bun run lint", 6_100, "$ oxlint\nFound 0 warnings and 0 errors.\n"),
    passed(
      "format",
      "command",
      "bun run fmt:check",
      2_300,
      "$ oxfmt --check\nAll matched files use the correct format.\n",
    ),
    passed("typecheck", "command", "bun run typecheck", 31_000, "$ tsc --noEmit\n"),
  ];
  const later = [
    check("build-status", "command", "pending", "bun run build:status", null),
    check("links", "command", "pending", "bun run links", null),
  ];
  const failed = ran(check("test", "command", "failed", "bun test", null), {
    attempt: 1,
    elapsedMs: 72_400,
    exitCode: 1,
    stdout:
      "bun test v1.4.2\n\npackages/audit/format/csv.test.ts:\n\u001b[32m✓\u001b[0m streams rows without buffering \u001b[2m[2.95ms]\u001b[0m\n\u001b[31m✗\u001b[0m escapes quotes inside quoted fields \u001b[2m[1.02ms]\u001b[0m\n\n \u001b[1m\u001b[32m211 pass\u001b[0m\n \u001b[1m\u001b[31m1 fail\u001b[0m\n",
    stderr: `\u001b[1m\u001b[31merror\u001b[0m: expect(received).toBe(expected)\n\n  Expected: \u001b[32m'"a""b"'\u001b[0m\n  Received: \u001b[31m'"a"b"'\u001b[0m\n\n      at packages/audit/format/csv.test.ts:41:27\n`,
  });
  const running = {
    ...check("test", "command", "running", "bun test", null),
    attempt: 2,
    elapsedMs: 74_000,
    active: true,
  };
  return {
    itemId: "ENG-102",
    runId: "r-102",
    maxAttempts: 3,
    blocked: null,
    updatedAt: "2026-10-09T22:13:46.000Z",
    attempts: [
      {
        number: 1,
        decision: "rejected",
        startedAt: "2026-10-09T22:05:10.000Z",
        baseSha: null,
        headSha: "2c41f9a",
        policyDigest: null,
        checks: [...setup, failed, ...later],
      },
      {
        number: 2,
        decision: "running",
        startedAt: "2026-10-09T22:13:46.000Z",
        baseSha: null,
        headSha: "4be81d0",
        policyDigest: null,
        checks: [...setup, running, ...later],
      },
    ],
    steps: [
      {
        at: "2026-10-09T22:05:02.000Z",
        tool: "get_closeout",
        checkId: null,
        state: "reported",
        attempt: null,
        headSha: "2c41f9a",
      },
      ...["install", "lint", "format", "typecheck"].map((checkId) => ({
        at: "2026-10-09T22:06:00.000Z",
        tool: "run_closeout" as const,
        checkId,
        state: "passed" as const,
        attempt: 1,
        headSha: "2c41f9a",
      })),
      {
        at: "2026-10-09T22:07:20.000Z",
        tool: "run_closeout",
        checkId: "test",
        state: "failed",
        attempt: 1,
        headSha: "2c41f9a",
      },
      {
        at: "2026-10-09T22:13:46.000Z",
        tool: "run_closeout",
        checkId: "test",
        state: "running",
        attempt: 2,
        headSha: "4be81d0",
      },
    ],
  };
}

export function statusFixture(): StatusSnapshot {
  return structuredClone(FIXTURE);
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
  timeline?: StatusItemEvent[];
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
    ...(input.timeline ? { timeline: input.timeline } : {}),
  };
}

function step(at: string, from: string, to: string, event: string): StatusItemEvent {
  return { at, kind: "transition", from, to, event, reason: null, actor: null };
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
