import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetro,
  getRetro,
  listRetroEvidence,
  migrate,
  openDatabase,
  publishRetro,
  readRetroActivity,
  readRetroArtifact,
  retroRepositories,
  saveRetroSettingsRevision,
  startRetroAttempt,
  sqliteDb,
} from "../db";
import {
  boundRetroDigest,
  buildRetroDigest,
  collectRetroDigest,
  redactRetroText,
  type RetroDigest,
} from "./index";

const REPO = "pmdroid/paws-app";
const OTHER = "pmdroid/paws-site";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const at = (days: number, ms = 0) => T0 + days * DAY + ms;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const db = openDatabase(":memory:");
  migrate(db);
  const root = mkdtempSync(join(tmpdir(), "paws-retro-digest-"));
  roots.push(root);
  workspace(db, "ws", "org", "team");
  return { db, root };
}

function workspace(db: Database, id: string, org: string, team: string) {
  db.run("INSERT INTO workspace VALUES (?, ?, ?, 0)", [id, org, id]);
  for (const repository of [REPO, OTHER])
    db.run("INSERT INTO workspace_repository VALUES (?, ?, ?)", [id, repository, team]);
}

let serial = 0;
function item(
  db: Database,
  identifier: string,
  input: { createdAt: number; repository?: string; org?: string; team?: string; state?: string },
): string {
  const id = `item-${identifier}`;
  const session = `session-${identifier}`;
  db.run(
    `INSERT INTO linear_session (session_id, issue_id, organization_id, team_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [session, `issue-${identifier}`, input.org ?? "org", input.team ?? "team", input.createdAt],
  );
  db.run(
    `INSERT INTO work_item (id, delegation_id, linear_issue_id, linear_identifier, title, state,
       branch_name, position, created_at, session_key, delegated_by, agent_ms, waiting_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'Jane Doe', 5000, 700)`,
    [
      id,
      `delegation-${identifier}`,
      `issue-${identifier}`,
      identifier,
      `Work on ${identifier}`,
      input.state ?? "queued",
      `paws/${identifier}`,
      input.createdAt,
      session,
    ],
  );
  const [owner, repo] = (input.repository ?? REPO).split("/");
  db.run("INSERT INTO work_item_repository VALUES (?, ?, ?, ?)", [id, owner!, repo!, "git@x"]);
  return id;
}

function transition(
  db: Database,
  itemId: string,
  input: { at: number; from: string; to: string; kind?: string; reason?: string; version?: number },
) {
  const version =
    input.version ??
    db
      .query<{ v: number }, [string]>(
        "SELECT coalesce(max(version), 0) + 1 AS v FROM work_item_event WHERE item_id = ?",
      )
      .get(itemId)!.v;
  db.run(
    `INSERT INTO work_item_event (item_id, version, at, from_state, to_state, event, kind, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      itemId,
      version,
      input.at,
      input.from,
      input.to,
      `${input.from}_to_${input.to}`,
      input.kind ?? "transition",
      input.reason ?? null,
    ],
  );
  db.run("UPDATE work_item SET version = ?, state = ? WHERE id = ?", [version, input.to, itemId]);
}

function question(
  db: Database,
  itemId: string,
  input: {
    createdAt: number;
    answeredAt?: number;
    answer?: string;
    body?: string;
    kind?: string;
    reason?: string;
    eventKey?: string;
  },
): string {
  const id = `q-${++serial}`;
  db.run(
    `INSERT INTO question (id, item_id, session_id, kind, reason, body, status, answer, answered_by,
       created_at, answered_at, answer_event_key) VALUES (?, ?, 's', ?, ?, ?, ?, ?, 'Jane Doe', ?, ?, ?)`,
    [
      id,
      itemId,
      input.kind ?? "agent",
      input.reason ?? null,
      input.body ?? "How should I continue?",
      input.answeredAt === undefined ? "open" : "answered",
      input.answeredAt === undefined ? null : (input.answer ?? "Fetch the branch and rebase."),
      input.createdAt,
      input.answeredAt ?? null,
      input.eventKey ?? null,
    ],
  );
  return id;
}

function message(
  db: Database,
  itemId: string,
  input: { eventKey: string; at: number; body: string; activityId?: string },
) {
  const session = db
    .query<{ s: string }, [string]>("SELECT session_key AS s FROM work_item WHERE id = ?")
    .get(itemId)!.s;
  db.run(
    `INSERT INTO linear_turn (event_key, activity_id, session_id, actor_id, body, payload,
       created_at_ms, received_at, item_id, state) VALUES (?, ?, ?, 'linear-user-9', ?, '{}', ?, ?, ?, 'applied')`,
    [input.eventKey, input.activityId ?? null, session, input.body, input.at, input.at, itemId],
  );
}

function settings(db: Database, repositories: string[], workspaceId = "ws") {
  return saveRetroSettingsRevision(db, {
    workspaceId,
    prompt: "Review {{digest}}",
    agentProfile: { agent: "codex" },
    repositories,
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { timeoutMinutes: 15, retries: 1 },
    schedule: {},
    createdBy: "user-1",
    now: 1,
  }).revision;
}

async function collect(
  db: Database,
  root: string,
  input: { id: string; start: number; end: number; repositories?: string[]; secrets?: string[] },
) {
  createRetro(db, {
    id: input.id,
    workspaceId: "ws",
    windowStart: input.start,
    windowEnd: input.end,
    origin: "manual",
    settingsRevision: settings(db, input.repositories ?? [REPO]),
    now: input.end,
  });
  const result = await collectRetroDigest(db, {
    retroId: input.id,
    artifactRoot: root,
    now: input.end,
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
  });
  if (!result.ok) throw new Error(`collection failed: ${result.reason}`);
  return result.digest;
}

function publish(db: Database, retroId: string, now: number) {
  const started = startRetroAttempt(db, { retroId, owner: "w", now, leaseMs: 60_000 })!;
  const published = publishRetro(db, {
    retroId,
    attempt: started.attempt,
    owner: "w",
    result: {},
    items: [],
    now,
  });
  expect(published.ok).toBe(true);
}

const counted = (digest: RetroDigest) =>
  digest.records.filter((record) => record.scope === "counted").map((r) => r.evidenceId);

describe("incremental retro windows", () => {
  test("the first retro starts at its window and a later one counts a new answer on an old item", async () => {
    const { db, root } = world();
    const old = item(db, "PAS-100", { createdAt: at(1) });
    const first = question(db, old, { createdAt: at(1, 5), answeredAt: at(2) });
    const first_digest = await collect(db, root, { id: "r1", start: at(0), end: at(3) });
    expect(first_digest.windows).toEqual([{ repository: REPO, start: at(0), end: at(3) }]);
    expect(first_digest.counts.answeredQuestions.evidenceIds).toEqual([`question:${first}`]);
    expect(first_digest.counts.sessions.newWorkItems).toBe(1);
    publish(db, "r1", at(3, 1));

    const second = question(db, old, { createdAt: at(4), answeredAt: at(5) });
    const fresh = item(db, "PAS-101", { createdAt: at(4) });
    const digest = await collect(db, root, { id: "r2", start: at(3), end: at(6) });
    expect(digest.windows[0]!.start).toBe(at(3));
    expect(digest.counts.sessions.workItems).toBe(2);
    expect(digest.counts.sessions.existingWorkItems).toBe(1);
    expect(digest.counts.sessions.newWorkItems).toBe(1);
    expect(digest.counts.answeredQuestions.evidenceIds).toEqual([`question:${second}`]);
    const session = digest.sessions.find((entry) => entry.itemId === old)!;
    expect(session.contextEvidenceIds).toEqual([`work_item:${old}`, `question:${first}`]);
    expect(counted(digest)).not.toContain(`question:${first}`);
    expect(digest.sessions.map((entry) => entry.itemId).sort()).toEqual([old, fresh].sort());
    expect((await getRetro(sqliteDb(db), "r2"))!.state).toBe("queued");
    expect(await retroRepositories(sqliteDb(db), "r2")).toEqual([
      { repository: REPO, startCursor: at(3), endCursor: at(6) },
    ]);
  });

  test("a record at the window start counts and one at the cutoff does not", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    await collect(db, root, { id: "r1", start: at(0), end: at(2) });
    publish(db, "r1", at(2));
    const atStart = question(db, id, { createdAt: at(2), answeredAt: at(2) });
    const beforeCut = question(db, id, { createdAt: at(2), answeredAt: at(4) - 1 });
    const atCut = question(db, id, { createdAt: at(3), answeredAt: at(4) });
    const digest = await collect(db, root, { id: "r2", start: at(2), end: at(4) });
    expect(digest.counts.answeredQuestions.evidenceIds).toEqual(
      [`question:${atStart}`, `question:${beforeCut}`].sort(),
    );
    expect(digest.records.map((record) => record.evidenceId)).not.toContain(`question:${atCut}`);
  });

  test("consecutive retros never count the same record twice and an overlapping one waits", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    for (let day = 0; day < 6; day += 1)
      transition(db, id, { at: at(day, 1), from: "queued", to: "running" });
    await collect(db, root, { id: "r1", start: at(0), end: at(3) });
    createRetro(db, {
      id: "r-overlap",
      workspaceId: "ws",
      windowStart: at(1),
      windowEnd: at(4),
      origin: "manual",
      settingsRevision: settings(db, [REPO]),
      now: at(4),
    });
    expect(
      await collectRetroDigest(db, { retroId: "r-overlap", artifactRoot: root, now: at(4) }),
    ).toEqual({ ok: false, reason: "busy", busy: [{ repository: REPO, retroId: "r1" }] });
    publish(db, "r1", at(3));
    const first = listRetroEvidence(db, "r1").map((entry) => entry.evidenceId);
    const digest = await collect(db, root, { id: "r2", start: at(3), end: at(7) });
    const both = new Set([
      ...first.filter((e) => e.startsWith("work_item_event")),
      ...counted(digest),
    ]);
    expect(
      counted(digest).filter((e) => first.includes(e) && e.startsWith("work_item_event")),
    ).toEqual([]);
    expect([...both].filter((e) => e.startsWith("work_item_event")).length).toBe(6);
  });

  test("an empty window still freezes a digest and a manifest", async () => {
    const { db, root } = world();
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    expect(digest.sessions).toEqual([]);
    expect(digest.counts.sessions.workItems).toBe(0);
    expect(digest.rates.every((entry) => entry.value === null && entry.denominator === 0)).toBe(
      true,
    );
    expect(readRetroArtifact(db, root, "r1", "digest").ok).toBe(true);
    const manifest = readRetroArtifact(db, root, "r1", "manifest");
    expect(
      manifest.ok && JSON.parse(new TextDecoder().decode(manifest.bytes)).prompt.sessionsIncluded,
    ).toBe(0);
    expect((await getRetro(sqliteDb(db), "r1"))!.state).toBe("queued");
  });

  test("collection stays inside the workspace and the teams that may read the repository", async () => {
    const { db, root } = world();
    workspace(db, "ws2", "org2", "team2");
    const mine = item(db, "PAS-1", { createdAt: at(1) });
    item(db, "ACME-1", { createdAt: at(1), org: "org2", team: "team2" });
    item(db, "PAS-2", { createdAt: at(1), team: "team-without-repositories" });
    db.run(
      "INSERT INTO workspace_repository VALUES ('ws', 'other/repo', 'team-without-repositories')",
    );
    item(db, "PAS-3", { createdAt: at(1), repository: OTHER });
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(2) });
    expect(digest.sessions.map((entry) => entry.itemId)).toEqual([mine]);
    expect(digest.coverage.unauthorizedItems).toBe(1);
    expect(JSON.stringify(digest)).not.toContain("ACME-1");
  });

  test("re-enabling a repository resumes its watermark and a new one starts at the retro window", async () => {
    const { db, root } = world();
    item(db, "PAS-1", { createdAt: at(0) });
    await collect(db, root, { id: "r1", start: at(0), end: at(2), repositories: [REPO, OTHER] });
    publish(db, "r1", at(2));
    await collect(db, root, { id: "r2", start: at(2), end: at(4), repositories: [REPO] });
    publish(db, "r2", at(4));
    const digest = await collect(db, root, {
      id: "r3",
      start: at(4),
      end: at(6),
      repositories: [REPO, OTHER],
    });
    expect(digest.windows).toEqual([
      { repository: REPO, start: at(4), end: at(6) },
      { repository: OTHER, start: at(2), end: at(6) },
    ]);
    db.run("INSERT INTO workspace_repository VALUES ('ws', 'pmdroid/new', 'team')");
    publish(db, "r3", at(6));
    const added = await collect(db, root, {
      id: "r4",
      start: at(6),
      end: at(8),
      repositories: [REPO, OTHER, "pmdroid/new"],
    });
    expect(added.windows.find((window) => window.repository === "pmdroid/new")!.start).toBe(at(6));
  });
});

describe("evidence quality", () => {
  test("an answer mirrored into linear_turn counts once and duplicate messages collapse", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    question(db, id, { createdAt: at(0, 1), answeredAt: at(0, 2), eventKey: "delivery-1" });
    message(db, id, { eventKey: "delivery-1", at: at(0, 2), body: "Fetch the branch and rebase." });
    message(db, id, { eventKey: "delivery-2", activityId: "a2", at: at(0, 3), body: "Ship it" });
    message(db, id, { eventKey: "delivery-3", activityId: "a3", at: at(0, 3), body: "Ship it " });
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    expect(digest.counts.answeredQuestions.events).toBe(1);
    expect(digest.counts.humanMessages.evidenceIds).toEqual(["linear_turn:delivery-2"]);
    expect(digest.coverage.mirroredAnswers).toEqual(["linear_turn:delivery-1"]);
    expect(digest.coverage.duplicateMessages).toEqual(["linear_turn:delivery-3"]);
    const ids = digest.records.map((record) => record.evidenceId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      listRetroEvidence(db, "r1")
        .map((entry) => entry.evidenceId)
        .sort(),
    ).toEqual([...ids].sort());
  });

  test("a failed Closeout step under a long progress id keeps its evidence id within 200 characters", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    const longProgress = `${id}\nPAS-1-${id}\n${"a".repeat(40)}\n${"b".repeat(64)}\n${"c".repeat(40)}`;
    const other = `${longProgress}x`;
    db.run(
      "INSERT INTO closeout_progress (id, item_id, task_id, base, head, policy_digest, started_at, updated_at) VALUES (?, ?, 't', 'b', 'h1', 'd', ?, ?), (?, ?, 't', 'b', 'h2', 'd', ?, ?)",
      [longProgress, id, at(0, 3), at(0, 3), other, id, at(0, 4), at(0, 4)],
    );
    db.run(
      `INSERT INTO closeout_step (progress_id, step_id, kind, state, command, attempt, ordinal, exit_code, finished_at)
       VALUES (?, 'build-status', 'command', 'failed', 'bun run build', 1, 1, 1, ?),
              (?, 'build-status', 'command', 'failed', 'bun run build', 1, 1, 1, ?)`,
      [longProgress, at(0, 3), other, at(0, 4)],
    );
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    const ids = digest.counts.failedChecks.groups.flatMap((group) => group.evidenceIds);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const evidenceId of ids) {
      expect(evidenceId.startsWith("closeout_step:")).toBe(true);
      expect(evidenceId.endsWith("/build-status")).toBe(true);
      expect(evidenceId.length).toBeLessThanOrEqual(200);
    }
  });

  test("restarts, failures, checks, findings, escapes, rebase returns and CI rounds stay separate", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    db.run("INSERT INTO item_pull_request VALUES (?, 42, 'https://pr', ?)", [id, at(0, 5)]);
    db.run(
      "INSERT INTO run (id, item_id, kind, agent, status, created_at, updated_at) VALUES ('run-1', ?, 'agent', 'codex', 'ended', ?, ?), ('run-2', ?, 'agent', 'codex', 'ended', ?, ?)",
      [id, at(0, 1), at(0, 2), id, at(0, 6), at(0, 7)],
    );
    transition(db, id, { at: at(0, 1), from: "queued", to: "running" });
    transition(db, id, {
      at: at(0, 2),
      from: "running",
      to: "running",
      kind: "restart",
      reason: "answer",
    });
    transition(db, id, {
      at: at(0, 3),
      from: "running",
      to: "running",
      kind: "restart",
      reason: "ci",
    });
    transition(db, id, { at: at(0, 4), from: "running", to: "failed" });
    db.run(
      "INSERT INTO closeout_progress (id, item_id, task_id, base, head, policy_digest, started_at, updated_at) VALUES ('p1', ?, 't', 'b', 'h1', 'd', ?, ?)",
      [id, at(0, 3), at(0, 3)],
    );
    db.run(
      `INSERT INTO closeout_step (progress_id, step_id, kind, state, command, attempt, ordinal, exit_code, finished_at)
       VALUES ('p1', 'test', 'command', 'failed', 'bun test', 1, 1, 1, ?),
              ('p1', 'lint', 'command', 'passed', 'bun lint', 1, 2, 0, ?)`,
      [at(0, 3), at(0, 3)],
    );
    db.run(
      `INSERT INTO review_finding (id, dedupe_key, repository, path, lines, severity, review, text,
         bug_class, why, first_item_id, first_head, first_seen_at, last_item_id, last_head, last_seen_at)
       VALUES (7, 'k7', ?, 'src/a.ts', '1', 'P1', 'review', 'Race on restart', 'race', 'pre-existing', ?, 'h', ?, ?, 'h', ?)`,
      [REPO, id, at(0, 3), id, at(0, 3)],
    );
    db.run("INSERT INTO review_finding_item VALUES (7, ?, 'h', ?)", [id, at(0, 3)]);
    db.run(
      "INSERT INTO review_escape (id, trigger_key, item_id, trigger, accepted_head, detail, recorded_at, is_escape) VALUES (1, 'e1', ?, 'ci', 'h', '{}', ?, 1), (2, 'e2', ?, 'review', 'h', '{}', ?, NULL)",
      [id, at(0, 5), id, at(0, 5)],
    );
    db.run(
      "INSERT INTO rebase_return (job_id, activation_id, item_id, reason, recorded_at) VALUES (1, 1, ?, 'push', ?), (2, 1, ?, 'merge', NULL)",
      [id, at(0, 5), id],
    );
    db.run("INSERT INTO ci_round VALUES (?, 'h1', NULL, 'asked', 2, 2, ?, ?)", [
      id,
      JSON.stringify([
        { name: "test", state: "failed" },
        { name: "lint", state: "passed" },
      ]),
      at(0, 5),
    ]);
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    const c = digest.counts;
    expect(c.sessions.workItems).toBe(1);
    expect(c.attempts.events).toBe(2);
    expect(c.requestedRestarts.groups.map((g) => g.key)).toEqual(["answer"]);
    expect(c.verificationReturns.groups.map((g) => g.key)).toEqual(["ci"]);
    expect(c.executionFailures.events).toBe(1);
    expect(c.failedChecks.groups).toEqual([
      expect.objectContaining({ key: "test", events: 1, evidenceIds: ["closeout_step:p1/test"] }),
    ]);
    expect(c.findings.distinctFindings).toBe(1);
    expect(c.escapes.groups.map((g) => [g.key, g.events])).toEqual([
      ["escape", 1],
      ["unsettled", 1],
    ]);
    expect(digest.records.find((r) => r.evidenceId === "review_escape:2")!.basis).toBe(
      "hypothesis",
    );
    expect(digest.records.find((r) => r.evidenceId === "review_finding:7/" + id)!.basis).toBe(
      "reported",
    );
    expect(c.rebaseReturns.evidenceIds).toEqual(["rebase_return:1/1"]);
    expect(digest.coverage.untimedRecords).toEqual(["rebase_return:2/1"]);
    expect(c.ciRounds.groups[0]).toMatchObject({ key: "asked", events: 1 });
    expect(digest.records.find((r) => r.sourceKind === "ci_round")!.summary).toContain("(test)");
    const confirmed = digest.rates.find((r) => r.name === "confirmed_escapes_of_settled")!;
    expect(confirmed).toMatchObject({
      numerator: 1,
      denominator: 1,
      coverage: { measured: 1, total: 2 },
    });
    expect(digest.sessions[0]!.pullNumber).toBe(42);
  });

  test("cutoff state is reconstructed from transitions and timing separates lifetime from interval", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    transition(db, id, { at: at(0, 100), from: "queued", to: "running" });
    transition(db, id, {
      at: at(0, 400),
      from: "running",
      to: "awaiting_input",
      kind: "ask",
      reason: "help",
    });
    transition(db, id, { at: at(2), from: "awaiting_input", to: "running" });
    const gap = item(db, "PAS-2", { createdAt: at(0) });
    transition(db, gap, { at: at(0, 50), from: "queued", to: "running", version: 3 });
    const quiet = item(db, "PAS-3", { createdAt: at(0, 10), state: "queued" });
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    const session = digest.sessions.find((entry) => entry.itemId === id)!;
    expect(session.stateAtCutoff).toEqual({
      state: "awaiting_input",
      basis: "transition_before_cutoff",
    });
    expect(session.stateAtCollection).toEqual({ state: "running", label: "collection_time" });
    expect(session.timing.interval).toMatchObject({
      capacityWaitMs: 100,
      executionMs: 300,
      personWaitMs: DAY - 400,
    });
    expect(session.timing.lifetime).toMatchObject({ agentMs: 5000, waitingMs: 700 });
    const gapped = digest.sessions.find((entry) => entry.itemId === gap)!;
    expect(gapped.stateAtCutoff).toEqual({ state: null, basis: "unknown" });
    expect(gapped.timing.interval.executionMs).toBeNull();
    expect(digest.coverage.transitionGaps).toEqual([`work_item:${gap}`]);
    const unchanged = digest.sessions.find((entry) => entry.itemId === quiet)!;
    expect(unchanged.stateAtCutoff).toEqual({ state: "queued", basis: "unchanged_since_creation" });
    expect(digest.stateAtCutoff.label).toBe("snapshot_at_cutoff");
    expect(digest.stateAtCutoff.totals.map((t) => [t.state, t.workItems])).toEqual([
      ["awaiting_input", 1],
      ["queued", 1],
    ]);
    expect(digest.stateAtCutoff.unknown.evidenceIds).toEqual([`work_item:${gap}`]);
    expect(digest.counts.asks.groups.map((g) => g.key)).toEqual(["help"]);
  });

  test("identity fields and known secrets never reach the stored digest or evidence", async () => {
    const { db, root } = world();
    const id = item(db, "PAS-1", { createdAt: at(0) });
    const token = `ghp_${"a".repeat(36)}`;
    question(db, id, {
      createdAt: at(0, 1),
      answeredAt: at(0, 2),
      answer: `Use ${token} and lin_api_${"b".repeat(32)}, ask @pascal or jane@example.com; also s3cret-value-123`,
    });
    const digest = await collect(db, root, {
      id: "r1",
      start: at(0),
      end: at(1),
      secrets: ["s3cret-value-123"],
    });
    const stored = readRetroArtifact(db, root, "r1", "digest");
    const text = stored.ok ? new TextDecoder().decode(stored.bytes) : "";
    const evidence = JSON.stringify(listRetroEvidence(db, "r1"));
    for (const leaked of [
      token,
      "lin_api_",
      "@pascal",
      "jane@example.com",
      "s3cret-value-123",
      "Jane Doe",
      "linear-user-9",
    ]) {
      expect(text).not.toContain(leaked);
      expect(evidence).not.toContain(leaked);
      expect(boundRetroDigest(digest).text).not.toContain(leaked);
    }
    expect(redactRetroText("password=hunter22 Bearer abcdefghijklmnop")).toBe(
      "password=[redacted] Bearer [redacted]",
    );
  });
});

describe("bounded prompt view", () => {
  test("truncation is deterministic per session and never changes the counts", async () => {
    const { db, root } = world();
    for (let index = 0; index < 12; index += 1) {
      const id = item(db, `PAS-${100 + index}`, { createdAt: at(0, index) });
      for (let n = 0; n < 8; n += 1)
        question(db, id, {
          createdAt: at(0, 50),
          answeredAt: at(0, 100 + n),
          body: "x".repeat(400),
        });
    }
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    const view = boundRetroDigest(digest, 9_000);
    expect(boundRetroDigest(digest, 9_000)).toEqual(view);
    expect(view.text.length).toBeLessThanOrEqual(9_000);
    expect(view.text).toContain("Answered questions: 96 events across 12 work items");
    const omitted = view.manifest.perSession.reduce((sum, entry) => sum + entry.countedOmitted, 0);
    const included = view.manifest.perSession.reduce(
      (sum, entry) => sum + entry.countedIncluded,
      0,
    );
    expect(included + omitted).toBe(counted(digest).length);
    expect(omitted).toBeGreaterThan(0);
    const manifest = readRetroArtifact(db, root, "r1", "manifest");
    expect(manifest.ok).toBe(true);
  });
});

describe("October retro fixture", () => {
  const PUSH_RECOVERY: [string, number][] = [
    ["PAS-817", 4],
    ["PAS-843", 5],
    ["PAS-835", 1],
    ["PAS-839", 2],
    ["PAS-844", 1],
    ["PAS-858", 5],
    ["PAS-860", 1],
  ];

  test("seven issues account for the 19 answered push-recovery questions", async () => {
    const { db, root } = world();
    PUSH_RECOVERY.forEach(([identifier, answers], index) => {
      const id = item(db, identifier, { createdAt: at(22, index) });
      for (let n = 0; n < answers; n += 1)
        question(db, id, {
          createdAt: at(23, n),
          answeredAt: at(24, index * 10 + n),
          reason: "push_rejected",
          body: "The push was rejected. How should I recover?",
          answer: "Fetch the branch and rebase onto its current tip.",
        });
      question(db, id, {
        createdAt: at(25),
        answeredAt: at(25, 1),
        kind: "visual-review",
        reason: "screenshots",
      });
    });
    const digest = await collect(db, root, { id: "october", start: at(22), end: at(28) });
    const push = digest.counts.answeredQuestions.groups.find(
      (g) => g.key === "agent/push_rejected",
    )!;
    expect(push.events).toBe(19);
    expect(push.workItems).toBe(7);
    expect(push.byWorkItem.map((entry) => [entry.identifier, entry.events])).toEqual(
      [...PUSH_RECOVERY].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    expect(push.evidenceIds.every((id) => id.startsWith("question:"))).toBe(true);
    expect(digest.counts.sessions.workItems).toBe(7);
    const snapshot = readRetroActivity(db, {
      workspaceId: "ws",
      repositories: [REPO],
      before: at(28),
    });
    expect(
      buildRetroDigest(snapshot, {
        retroId: "october",
        windows: digest.windows,
        cut: digest.cut,
        collectedAt: digest.collectedAt,
      }),
    ).toEqual(digest);
  });
});
