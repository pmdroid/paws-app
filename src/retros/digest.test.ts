import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetro,
  getRetro,
  listRetroEvidence,
  publishRetro,
  readRetroActivity,
  readRetroArtifact,
  retroRepositories,
  saveRetroSettingsRevision,
  startRetroAttempt,
  getWorkItem,
  type Db,
  type Q,
} from "../db";
import {
  boundRetroDigest,
  buildRetroDigest,
  collectRetroDigest,
  redactRetroText,
  type RetroDigest,
} from "./index";
import { json, seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const REPO = "pmdroid/paws-app";
const OTHER = "pmdroid/paws-site";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const at = (days: number, ms = 0) => T0 + days * DAY + ms;

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world() {
  const { db, close } = await tempStore();
  const root = mkdtempSync(join(tmpdir(), "paws-retro-digest-"));
  roots.push(root);
  closes.push(close);
  await workspace(db, "ws", "org", "team");
  return { db, root };
}

async function workspace(db: Db, id: string, org: string, team: string) {
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({ id, linearOrganizationId: org, name: id, createdAt: 0 }),
    ...[REPO, OTHER].map(
      (repository) => (q: Q) =>
        q.orm.insert(q.t.workspaceRepository).values({ workspaceId: id, repository, teamId: team }),
    ),
  );
}

let serial = 0;
async function item(
  db: Db,
  identifier: string,
  input: { createdAt: number; repository?: string; org?: string; team?: string; state?: string },
): Promise<string> {
  const id = `item-${identifier}`;
  const session = `session-${identifier}`;
  const [owner, repo] = (input.repository ?? REPO).split("/");
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: session,
        issueId: `issue-${identifier}`,
        organizationId: input.org ?? "org",
        teamId: input.team ?? "team",
        createdAt: input.createdAt,
      }),
    (q) =>
      q.orm.insert(q.t.workItem).values({
        id,
        delegationId: `delegation-${identifier}`,
        linearIssueId: `issue-${identifier}`,
        linearIdentifier: identifier,
        title: `Work on ${identifier}`,
        state: input.state ?? "queued",
        branchName: `paws/${identifier}`,
        position: 0,
        createdAt: input.createdAt,
        sessionKey: session,
        delegatedBy: "Jane Doe",
        agentMs: 5000,
        waitingMs: 700,
      }),
    (q) =>
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: id, owner: owner!, repo: repo!, remoteUrl: "git@x" }),
  );
  return id;
}

async function transition(
  db: Db,
  itemId: string,
  input: { at: number; from: string; to: string; kind?: string; reason?: string; version?: number },
) {
  await db.run(function* (q) {
    const { workItem, workItemEvent } = q.t;
    const version =
      input.version ??
      (yield* q.one(
        q.orm
          .select({
            v: sql<number>`coalesce(max(${workItemEvent.version}), 0) + 1`.mapWith(Number),
          })
          .from(workItemEvent)
          .where(eq(workItemEvent.itemId, itemId)),
      ))!.v;
    yield* q.exec(
      q.orm.insert(workItemEvent).values({
        itemId,
        version,
        at: input.at,
        fromState: input.from,
        toState: input.to,
        event: `${input.from}_to_${input.to}`,
        kind: input.kind ?? "transition",
        reason: input.reason ?? null,
      }),
    );
    yield* q.exec(
      q.orm.update(workItem).set({ version, state: input.to }).where(eq(workItem.id, itemId)),
    );
  });
}

async function question(
  db: Db,
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
): Promise<string> {
  const id = `q-${++serial}`;
  await seed(db, (q) =>
    q.orm.insert(q.t.question).values({
      id,
      itemId,
      sessionId: "s",
      kind: input.kind ?? "agent",
      reason: input.reason ?? null,
      body: input.body ?? "How should I continue?",
      status: input.answeredAt === undefined ? "open" : "answered",
      answer:
        input.answeredAt === undefined ? null : (input.answer ?? "Fetch the branch and rebase."),
      answeredBy: "Jane Doe",
      createdAt: input.createdAt,
      answeredAt: input.answeredAt ?? null,
      answerEventKey: input.eventKey ?? null,
    }),
  );
  return id;
}

async function message(
  db: Db,
  itemId: string,
  input: { eventKey: string; at: number; body: string; activityId?: string },
) {
  const session = (await getWorkItem(db, itemId))!.sessionKey;
  await seed(db, (q) =>
    q.orm.insert(q.t.linearTurn).values({
      eventKey: input.eventKey,
      activityId: input.activityId ?? null,
      sessionId: session!,
      actorId: "linear-user-9",
      body: input.body,
      payload: json(db, {}),
      createdAtMs: input.at,
      receivedAt: input.at,
      itemId,
      state: "applied",
    }),
  );
}

function progressRow(q: Q, id: string, itemId: string, head: string, time: number) {
  return q.orm.insert(q.t.closeoutProgress).values({
    id,
    itemId,
    taskId: "t",
    base: "b",
    head,
    policyDigest: "d",
    startedAt: time,
    updatedAt: time,
  });
}

function stepRow(
  q: Q,
  progressId: string,
  stepId: string,
  state: string,
  command: string,
  ordinal: number,
  finishedAt: number,
) {
  return q.orm.insert(q.t.closeoutStep).values({
    progressId,
    stepId,
    kind: "command",
    state,
    command,
    attempt: 1,
    ordinal,
    exitCode: state === "failed" ? 1 : 0,
    finishedAt,
  });
}

async function settings(db: Db, repositories: string[], workspaceId = "ws") {
  return (
    await saveRetroSettingsRevision(db, {
      workspaceId,
      prompt: "Review {{digest}}",
      agentProfile: { agent: "codex" },
      repositories,
      outputLimits: { maxItems: 5, workedWell: 3 },
      executionLimits: { timeoutMinutes: 15, retries: 1 },
      schedule: {},
      createdBy: "user-1",
      now: 1,
    })
  ).revision;
}

async function collect(
  db: Db,
  root: string,
  input: { id: string; start: number; end: number; repositories?: string[]; secrets?: string[] },
) {
  await createRetro(db, {
    id: input.id,
    workspaceId: "ws",
    windowStart: input.start,
    windowEnd: input.end,
    origin: "manual",
    settingsRevision: await settings(db, input.repositories ?? [REPO]),
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

async function publish(db: Db, retroId: string, now: number) {
  const started = (await startRetroAttempt(db, {
    retroId,
    owner: "w",
    now,
    leaseMs: 60_000,
  }))!;
  const published = await publishRetro(db, {
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
    const { db, root } = await world();
    const old = await item(db, "PAS-100", { createdAt: at(1) });
    const first = await question(db, old, { createdAt: at(1, 5), answeredAt: at(2) });
    const first_digest = await collect(db, root, { id: "r1", start: at(0), end: at(3) });
    expect(first_digest.windows).toEqual([{ repository: REPO, start: at(0), end: at(3) }]);
    expect(first_digest.counts.answeredQuestions.evidenceIds).toEqual([`question:${first}`]);
    expect(first_digest.counts.sessions.newWorkItems).toBe(1);
    await publish(db, "r1", at(3, 1));

    const second = await question(db, old, { createdAt: at(4), answeredAt: at(5) });
    const fresh = await item(db, "PAS-101", { createdAt: at(4) });
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
    expect((await getRetro(db, "r2"))!.state).toBe("queued");
    expect(await retroRepositories(db, "r2")).toEqual([
      { repository: REPO, startCursor: at(3), endCursor: at(6) },
    ]);
  });

  test("a record at the window start counts and one at the cutoff does not", async () => {
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    await collect(db, root, { id: "r1", start: at(0), end: at(2) });
    await publish(db, "r1", at(2));
    const atStart = await question(db, id, { createdAt: at(2), answeredAt: at(2) });
    const beforeCut = await question(db, id, { createdAt: at(2), answeredAt: at(4) - 1 });
    const atCut = await question(db, id, { createdAt: at(3), answeredAt: at(4) });
    const digest = await collect(db, root, { id: "r2", start: at(2), end: at(4) });
    expect(digest.counts.answeredQuestions.evidenceIds).toEqual(
      [`question:${atStart}`, `question:${beforeCut}`].sort(),
    );
    expect(digest.records.map((record) => record.evidenceId)).not.toContain(`question:${atCut}`);
  });

  test("consecutive retros never count the same record twice and an overlapping one waits", async () => {
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    for (let day = 0; day < 6; day += 1)
      await transition(db, id, { at: at(day, 1), from: "queued", to: "running" });
    await collect(db, root, { id: "r1", start: at(0), end: at(3) });
    await createRetro(db, {
      id: "r-overlap",
      workspaceId: "ws",
      windowStart: at(1),
      windowEnd: at(4),
      origin: "manual",
      settingsRevision: await settings(db, [REPO]),
      now: at(4),
    });
    expect(
      await collectRetroDigest(db, {
        retroId: "r-overlap",
        artifactRoot: root,
        now: at(4),
      }),
    ).toEqual({ ok: false, reason: "busy", busy: [{ repository: REPO, retroId: "r1" }] });
    await publish(db, "r1", at(3));
    const first = (await listRetroEvidence(db, "r1")).map((entry) => entry.evidenceId);
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
    const { db, root } = await world();
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    expect(digest.sessions).toEqual([]);
    expect(digest.counts.sessions.workItems).toBe(0);
    expect(digest.rates.every((entry) => entry.value === null && entry.denominator === 0)).toBe(
      true,
    );
    expect((await readRetroArtifact(db, root, "r1", "digest")).ok).toBe(true);
    const manifest = await readRetroArtifact(db, root, "r1", "manifest");
    expect(
      manifest.ok && JSON.parse(new TextDecoder().decode(manifest.bytes)).prompt.sessionsIncluded,
    ).toBe(0);
    expect((await getRetro(db, "r1"))!.state).toBe("queued");
  });

  test("collection stays inside the workspace and the teams that may read the repository", async () => {
    const { db, root } = await world();
    await workspace(db, "ws2", "org2", "team2");
    const mine = await item(db, "PAS-1", { createdAt: at(1) });
    await item(db, "ACME-1", { createdAt: at(1), org: "org2", team: "team2" });
    await item(db, "PAS-2", { createdAt: at(1), team: "team-without-repositories" });
    await seed(db, (q) =>
      q.orm.insert(q.t.workspaceRepository).values({
        workspaceId: "ws",
        repository: "other/repo",
        teamId: "team-without-repositories",
      }),
    );
    await item(db, "PAS-3", { createdAt: at(1), repository: OTHER });
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(2) });
    expect(digest.sessions.map((entry) => entry.itemId)).toEqual([mine]);
    expect(digest.coverage.unauthorizedItems).toBe(1);
    expect(JSON.stringify(digest)).not.toContain("ACME-1");
  });

  test("re-enabling a repository resumes its watermark and a new one starts at the retro window", async () => {
    const { db, root } = await world();
    await item(db, "PAS-1", { createdAt: at(0) });
    await collect(db, root, { id: "r1", start: at(0), end: at(2), repositories: [REPO, OTHER] });
    await publish(db, "r1", at(2));
    await collect(db, root, { id: "r2", start: at(2), end: at(4), repositories: [REPO] });
    await publish(db, "r2", at(4));
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
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "ws", repository: "pmdroid/new", teamId: "team" }),
    );
    await publish(db, "r3", at(6));
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
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    await question(db, id, { createdAt: at(0, 1), answeredAt: at(0, 2), eventKey: "delivery-1" });
    await message(db, id, {
      eventKey: "delivery-1",
      at: at(0, 2),
      body: "Fetch the branch and rebase.",
    });
    await message(db, id, {
      eventKey: "delivery-2",
      activityId: "a2",
      at: at(0, 3),
      body: "Ship it",
    });
    await message(db, id, {
      eventKey: "delivery-3",
      activityId: "a3",
      at: at(0, 3),
      body: "Ship it ",
    });
    const digest = await collect(db, root, { id: "r1", start: at(0), end: at(1) });
    expect(digest.counts.answeredQuestions.events).toBe(1);
    expect(digest.counts.humanMessages.evidenceIds).toEqual(["linear_turn:delivery-2"]);
    expect(digest.coverage.mirroredAnswers).toEqual(["linear_turn:delivery-1"]);
    expect(digest.coverage.duplicateMessages).toEqual(["linear_turn:delivery-3"]);
    const ids = digest.records.map((record) => record.evidenceId);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await listRetroEvidence(db, "r1")).map((entry) => entry.evidenceId).sort()).toEqual(
      [...ids].sort(),
    );
  });

  test("a failed Closeout step under a long progress id keeps its evidence id within 200 characters", async () => {
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    const longProgress = `${id}\nPAS-1-${id}\n${"a".repeat(40)}\n${"b".repeat(64)}\n${"c".repeat(40)}`;
    const other = `${longProgress}x`;
    await seed(
      db,
      ...[
        [longProgress, "h1", at(0, 3)],
        [other, "h2", at(0, 4)],
      ].map(
        ([progress, head, when]) =>
          (q: Q) =>
            progressRow(q, progress as string, id, head as string, when as number),
      ),
      ...[
        [longProgress, at(0, 3)],
        [other, at(0, 4)],
      ].map(
        ([progress, when]) =>
          (q: Q) =>
            stepRow(
              q,
              progress as string,
              "build-status",
              "failed",
              "bun run build",
              1,
              when as number,
            ),
      ),
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
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.itemPullRequest)
          .values({ itemId: id, pullNumber: 42, pullUrl: "https://pr", openedAt: at(0, 5) }),
      (q) =>
        q.orm.insert(q.t.run).values(
          [
            ["run-1", at(0, 1), at(0, 2)],
            ["run-2", at(0, 6), at(0, 7)],
          ].map(([runId, createdAt, updatedAt]) => ({
            id: runId as string,
            itemId: id,
            kind: "agent",
            agent: "codex",
            status: "ended",
            createdAt: createdAt as number,
            updatedAt: updatedAt as number,
          })),
        ),
    );
    await transition(db, id, { at: at(0, 1), from: "queued", to: "running" });
    await transition(db, id, {
      at: at(0, 2),
      from: "running",
      to: "running",
      kind: "restart",
      reason: "answer",
    });
    await transition(db, id, {
      at: at(0, 3),
      from: "running",
      to: "running",
      kind: "restart",
      reason: "ci",
    });
    await transition(db, id, { at: at(0, 4), from: "running", to: "failed" });
    await seed(
      db,
      (q) => progressRow(q, "p1", id, "h1", at(0, 3)),
      (q) => stepRow(q, "p1", "test", "failed", "bun test", 1, at(0, 3)),
      (q) => stepRow(q, "p1", "lint", "passed", "bun lint", 2, at(0, 3)),
      (q) =>
        q.orm.insert(q.t.reviewFinding).values({
          id: 7,
          dedupeKey: "k7",
          repository: REPO,
          path: "src/a.ts",
          lines: "1",
          severity: "P1",
          review: "review",
          text: "Race on restart",
          bugClass: "race",
          why: "pre-existing",
          firstItemId: id,
          firstHead: "h",
          firstSeenAt: at(0, 3),
          lastItemId: id,
          lastHead: "h",
          lastSeenAt: at(0, 3),
        }),
      (q) =>
        q.orm
          .insert(q.t.reviewFindingItem)
          .values({ findingId: 7, itemId: id, headSha: "h", seenAt: at(0, 3) }),
      (q) =>
        q.orm.insert(q.t.reviewEscape).values(
          (
            [
              [1, "e1", "ci", 1],
              [2, "e2", "review", null],
            ] as const
          ).map(([escapeId, triggerKey, trigger, isEscape]) => ({
            id: escapeId,
            triggerKey,
            itemId: id,
            trigger,
            acceptedHead: "h",
            detail: json(db, {}),
            recordedAt: at(0, 5),
            isEscape,
          })),
        ),
      (q) =>
        q.orm.insert(q.t.rebaseReturn).values([
          { jobId: 1, activationId: 1, itemId: id, reason: "push", recordedAt: at(0, 5) },
          { jobId: 2, activationId: 1, itemId: id, reason: "merge", recordedAt: null },
        ]),
      (q) =>
        q.orm.insert(q.t.ciRound).values({
          itemId: id,
          head: "h1",
          runId: null,
          next: "asked",
          fix: 2,
          fixLimit: 2,
          checks: json(db, [
            { name: "test", state: "failed" },
            { name: "lint", state: "passed" },
          ]),
          recordedAt: at(0, 5),
        }),
    );
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
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    await transition(db, id, { at: at(0, 100), from: "queued", to: "running" });
    await transition(db, id, {
      at: at(0, 400),
      from: "running",
      to: "awaiting_input",
      kind: "ask",
      reason: "help",
    });
    await transition(db, id, { at: at(2), from: "awaiting_input", to: "running" });
    const gap = await item(db, "PAS-2", { createdAt: at(0) });
    await transition(db, gap, { at: at(0, 50), from: "queued", to: "running", version: 3 });
    const quiet = await item(db, "PAS-3", { createdAt: at(0, 10), state: "queued" });
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
    const { db, root } = await world();
    const id = await item(db, "PAS-1", { createdAt: at(0) });
    const token = `ghp_${"a".repeat(36)}`;
    await question(db, id, {
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
    const stored = await readRetroArtifact(db, root, "r1", "digest");
    const text = stored.ok ? new TextDecoder().decode(stored.bytes) : "";
    const evidence = JSON.stringify(await listRetroEvidence(db, "r1"));
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
    const { db, root } = await world();
    for (let index = 0; index < 12; index += 1) {
      const id = await item(db, `PAS-${100 + index}`, { createdAt: at(0, index) });
      for (let n = 0; n < 8; n += 1)
        await question(db, id, {
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
    const manifest = await readRetroArtifact(db, root, "r1", "manifest");
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
    const { db, root } = await world();
    for (const [index, [identifier, answers]] of PUSH_RECOVERY.entries()) {
      const id = await item(db, identifier, { createdAt: at(22, index) });
      for (let n = 0; n < answers; n += 1)
        await question(db, id, {
          createdAt: at(23, n),
          answeredAt: at(24, index * 10 + n),
          reason: "push_rejected",
          body: "The push was rejected. How should I recover?",
          answer: "Fetch the branch and rebase onto its current tip.",
        });
      await question(db, id, {
        createdAt: at(25),
        answeredAt: at(25, 1),
        kind: "visual-review",
        reason: "screenshots",
      });
    }
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
    const snapshot = await readRetroActivity(db, {
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
