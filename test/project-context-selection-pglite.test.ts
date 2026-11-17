import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  claimContextCompaction,
  requestContextCompaction,
  pgSchema,
  publishContextSummary,
  type ContextClaim,
  type ContextClassification,
  type ContextNamespace,
  type ContextRestriction,
  type Db,
} from "../src/db";
import {
  CONTEXT_BUDGET_DEFAULTS,
  compactContext,
  correctContext,
  createContextCapacity,
  createFakeContextAccess,
  createFakeContextSummarizer,
  createFakeProjectContextReads,
  disconnectContext,
  estimateContextTokens,
  forgetContextSource,
  ingestContext,
  invalidateContext,
  retrieveContextDetail,
  selectContext,
  validateContextBudget,
  type ContextBudgetSettings,
  type ContextDestination,
  type ContextRequester,
  type ContextSelection,
  type ContextSelectionRequest,
  type FakeContextAccess,
} from "../src/project-context";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

const SMALL: Partial<ContextBudgetSettings> = {
  hardCapTokens: 4_000,
  responseTokens: 1_000,
  memoryTokens: 800,
  recentTokens: 300,
  softThresholdTokens: 500,
  summaryOutputTokens: 200,
  summaryInputTokens: 2_000,
  candidates: 120,
  references: 6,
  summaryTimeoutMs: 1_000,
  compactionRetryMs: 60_000,
};

const ROOMY: Partial<ContextBudgetSettings> = { ...SMALL, memoryTokens: 1_200 };

const project: ContextDestination = { audience: "project_members" };

function fixture() {
  seq++;
  const workspaceId = `ws-sel-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: `project-${seq}`,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: [] });
  return { workspaceId, namespace, alice, access };
}

const claim = (
  key: string,
  body: string,
  classification: ContextClassification = "reported_fact",
  importance = 1,
): ContextClaim => ({ key, layer: "observation", classification, importance, body });

async function put(
  access: FakeContextAccess,
  namespace: ContextNamespace,
  requester: ContextRequester,
  id: string,
  claims: readonly ContextClaim[],
  options: { at?: number; restriction?: ContextRestriction; kind?: string } = {},
) {
  const at = options.at ?? T0;
  const outcome = await ingestContext(db, access, {
    namespace,
    requester,
    source: {
      kind: options.kind ?? "linear_project_document",
      id,
      url: `https://linear.app/doc/${id}`,
      revision: `rev-${at}`,
      revisionAt: at,
      actorId: "writer",
      restriction: options.restriction ?? { teamIds: ["team-a"] },
    },
    claims,
    now: at,
  });
  return outcome;
}

function selection(
  namespace: ContextNamespace,
  requester: ContextRequester,
  overrides: Partial<ContextSelectionRequest> = {},
): ContextSelectionRequest {
  return {
    namespace,
    requester,
    destination: project,
    instructions: "You are working on a Paws task.",
    request: "Fix the billing export retry behaviour",
    toolsTokens: 300,
    repository: "acme/app",
    recent: [{ text: "Last turn: looked at the billing exporter.", at: T0 }],
    model: { contextTokens: 100_000 },
    settings: SMALL,
    now: T0 + MINUTE,
    ...overrides,
  };
}

function ok(result: ContextSelection) {
  if (result.status !== "ok") throw new Error(`selection ${JSON.stringify(result)}`);
  return result;
}

function withinBudget(result: ReturnType<typeof ok>) {
  const { tokens } = result.manifest;
  expect(tokens.total).toBeLessThanOrEqual(tokens.hardCap);
  expect(tokens.memoryUsed).toBeLessThanOrEqual(tokens.memoryBudget);
  expect(tokens.recentUsed).toBeLessThanOrEqual(tokens.recentBudget);
  expect(estimateContextTokens(result.pack)).toBe(tokens.memoryUsed);
  expect(tokens.total).toBe(
    tokens.instructions +
      tokens.request +
      tokens.tools +
      tokens.response +
      tokens.recentUsed +
      tokens.memoryUsed,
  );
}

async function allSummaryText(): Promise<string> {
  const rows = await db.orm
    .select({ body: pgSchema.contextSummary.body })
    .from(pgSchema.contextSummary);
  return rows.map((row) => row.body).join("\n");
}

async function compact(
  access: FakeContextAccess,
  namespace: ContextNamespace,
  requester: ContextRequester,
  summarizer = createFakeContextSummarizer(),
  now = T0 + 2 * MINUTE,
  capacity = createContextCapacity(),
) {
  return compactContext(db, access, summarizer, capacity, {
    namespace,
    requester,
    destination: project,
    settings: SMALL,
    now,
  });
}

test("budget settings have valid defaults and invalid settings are rejected", () => {
  expect(validateContextBudget()).toEqual({ ok: true, settings: CONTEXT_BUDGET_DEFAULTS });
  for (const bad of [
    { softThresholdTokens: 6_000 },
    { softThresholdTokens: 7_000 },
    { summaryOutputTokens: 4_500 },
    { memoryTokens: Number.NaN },
    { candidates: 201 },
    { hardCapTokens: 10_000, memoryTokens: 6_000, recentTokens: 4_000 },
    { recentTokens: -1 },
    { references: 1.5 },
  ] satisfies Partial<ContextBudgetSettings>[])
    expect(validateContextBudget(bad).ok).toBe(false);
});

test("invalid budgets are rejected by selection and compaction, and a too-small model is unavailable", async () => {
  const { namespace, alice, access } = fixture();
  const invalid = await selectContext(
    db,
    access,
    selection(namespace, alice, { settings: { softThresholdTokens: 900, memoryTokens: 800 } }),
  );
  expect(invalid.status).toBe("invalid_budget");
  expect(
    (await selectContext(db, access, selection(namespace, alice, { model: { contextTokens: 0 } })))
      .status,
  ).toBe("invalid_budget");
  expect(
    (await selectContext(db, access, selection(namespace, alice, { toolsTokens: -3 }))).status,
  ).toBe("invalid_budget");
  const run = await compactContext(
    db,
    access,
    createFakeContextSummarizer(),
    createContextCapacity(),
    {
      namespace,
      requester: alice,
      destination: project,
      settings: { summaryOutputTokens: 5_000 },
      now: T0,
    },
  );
  expect(run.status).toBe("invalid_budget");
  expect(
    await selectContext(
      db,
      access,
      selection(namespace, alice, { model: { contextTokens: 1_200 } }),
    ),
  ).toEqual({ status: "unavailable", reason: "over_budget" });
});

test("10,000 records across workspaces, projects and repositories stay inside every bound", async () => {
  const access = createFakeContextAccess();
  const reads = createFakeProjectContextReads();
  const workspaces = [`ws-big-a-${seq}`, `ws-big-b-${seq}`];
  seq++;
  let total = 0;
  const target = {
    workspaceId: workspaces[0]!,
    scopeKind: "linear_project",
    scopeId: "p-0",
  } as const;
  const alice: ContextRequester = { workspaceId: workspaces[0]!, userId: "alice-big" };
  for (const workspaceId of workspaces) {
    const writer = { workspaceId, userId: "alice-big" };
    access.grant(writer, {
      teamIds: ["team-a"],
      repositories: ["acme/app", "acme/api"],
      channelIds: [],
    });
    for (let p = 0; p < 5; p++) {
      const namespace = { workspaceId, scopeKind: "linear_project", scopeId: `p-${p}` } as const;
      for (let s = 0; s < 25; s++) {
        const repository = s % 5 === 0 ? (s % 2 ? "acme/app" : "acme/api") : undefined;
        const claims = Array.from({ length: 40 }, (_, i) =>
          claim(
            `k-${s}-${i}`,
            `Fact ${workspaceId} ${namespace.scopeId} source ${s} item ${i}: retries and exports keep ${"detail ".repeat(i % 7)}`,
            i % 13 === 0 ? "inference" : "reported_fact",
            i % 3,
          ),
        );
        const outcome = await put(access, namespace, writer, `doc-${s}`, claims, {
          at: T0 - (s + p) * MINUTE,
          restriction: repository ? { teamIds: ["team-a"], repository } : { teamIds: ["team-a"] },
        });
        expect(outcome.status).toBe("stored");
        total += claims.length;
      }
    }
  }
  expect(total).toBe(10_000);
  await put(
    access,
    target,
    alice,
    "doc-open",
    [
      claim(
        "q",
        "Question: should billing export retries back off exponentially?",
        "unresolved_question",
        4,
      ),
      claim("d", "Decision: billing exports run nightly.", "decision", 4),
    ],
    { at: T0 - 9 * 24 * 60 * MINUTE },
  );

  const result = ok(
    await selectContext(db, access, selection(target, alice, { now: T0 + MINUTE })),
  );
  withinBudget(result);
  expect(result.manifest.work.candidatesRead).toBeLessThanOrEqual(SMALL.candidates!);
  expect(result.manifest.references.length).toBeLessThanOrEqual(SMALL.references!);
  expect(Buffer.byteLength(result.pack)).toBeLessThanOrEqual(SMALL.memoryTokens! * 2);
  expect(result.pack).toContain("should billing export retries back off exponentially?");
  expect(result.pack).toContain("billing exports run nightly");
  expect(result.recent).toContain("looked at the billing exporter");
  expect(result.manifest.sources.some((source) => source.sourceId === "doc-open")).toBe(true);
  expect(result.pack).not.toContain(workspaces[1]!);
  expect(result.pack).not.toMatch(/ p-[1-4] /);
  expect(result.manifest.counts.suppressed).toBeGreaterThan(0);
  expect(result.manifest.compaction).toBe("requested");
  expect(reads.calls).toEqual([]);
  for (const contextTokens of [2_400, 2_600, 3_000, 4_000, 200_000]) {
    const again = ok(
      await selectContext(
        db,
        access,
        selection(target, alice, { model: { contextTokens, outputTokens: 900 } }),
      ),
    );
    withinBudget(again);
    expect(again.manifest.tokens.hardCap).toBe(Math.min(4_000, contextTokens));
  }
}, 120_000);

test("triggers coalesce, compaction publishes a summary, and repeated crossings never overflow", async () => {
  const { namespace, alice, access } = fixture();
  const summarizer = createFakeContextSummarizer();
  await put(access, namespace, alice, "doc-q", [
    claim("q1", "Question: do retries cover partial exports?", "unresolved_question", 3),
    claim("d1", "Decision: exports are idempotent.", "decision", 3),
    claim("i1", "Exports might be slow on Mondays.", "inference", 1),
    claim("d2", "Decision: exports are NOT idempotent.", "decision", 3),
  ]);
  for (let round = 0; round < 4; round++) {
    const facts = Array.from({ length: 30 }, (_, i) =>
      claim(
        `f-${round}-${i}`,
        `Round ${round} fact ${i}: the exporter writes CSV batches of ${i * 100} rows.`,
      ),
    );
    await put(access, namespace, alice, `doc-facts-${round}`, facts, { at: T0 + round * MINUTE });
    const now = T0 + round * 10 * MINUTE + MINUTE;
    const first = ok(
      await selectContext(db, access, selection(namespace, alice, { now, settings: ROOMY })),
    );
    withinBudget(first);
    expect(first.manifest.compaction).toBe(round === 0 ? "requested" : first.manifest.compaction);
    expect(["requested", "coalesced"]).toContain(first.manifest.compaction);
    const second = ok(
      await selectContext(db, access, selection(namespace, alice, { now, settings: ROOMY })),
    );
    expect(second.manifest.compaction).toBe("coalesced");
    const summaries = await db.orm
      .select()
      .from(pgSchema.contextSummary)
      .where(eqWorkspace(namespace.workspaceId));
    expect(summaries).toHaveLength(1);

    if (round === 2) summarizer.mode = "resolve_everything";
    const run = await compact(access, namespace, alice, summarizer, now + MINUTE);
    expect(run.status).toBe("ok");
    const outcomes = run.status === "ok" ? run.outcomes.map((o) => o.status) : [];
    if (round % 2 === 0) expect(outcomes).toEqual(["published"]);
    else expect([["published"], ["nothing_to_do"]]).toContainEqual(outcomes);
    summarizer.mode = "extractive";

    for (const contextTokens of [2_500, 4_000]) {
      const after = ok(
        await selectContext(
          db,
          access,
          selection(namespace, alice, {
            now: now + 2 * MINUTE,
            model: { contextTokens },
            settings: ROOMY,
          }),
        ),
      );
      withinBudget(after);
      expect(after.pack).toContain("Question: do retries cover partial exports?");
      expect(after.pack).toContain("Decision: exports are idempotent.");
      expect(after.pack).toContain("Decision: exports are NOT idempotent.");
      expect(after.pack).toContain("[unresolved_question]");
      const inference = (await db.orm.select().from(pgSchema.contextRecord)).find(
        (row) => row.body === "Exports might be slow on Mondays." && row.status === "current",
      )!;
      if (contextTokens === 4_000) expect(after.pack).toContain("[inference]");
      else
        expect(
          after.pack.includes("[inference]") ||
            after.manifest.references.some((ref) => ref.recordId === inference.id),
        ).toBe(true);
      if (contextTokens === 4_000) {
        expect(after.manifest.summary).not.toBeNull();
        expect(after.manifest.summary!.covered).toBeGreaterThan(0);
        expect(after.pack).toContain("Derived summary of settled facts (not a source)");
      }
    }
  }
  for (const call of summarizer.calls)
    for (const record of call.records)
      expect(["reported_fact", "verified_fact"]).toContain(record.classification);
  const sent = summarizer.calls
    .flatMap((call) => call.records.map((record) => record.body))
    .join("\n");
  expect(sent).not.toContain("Question:");
  expect(sent).not.toContain("Decision:");
});

function eqWorkspace(workspaceId: string) {
  return eq(pgSchema.contextSummary.workspaceId, workspaceId);
}

test("a correction outranks the stale summary and survives later compactions", async () => {
  const { namespace, alice, access } = fixture();
  await put(
    access,
    namespace,
    alice,
    "doc-a",
    Array.from({ length: 30 }, (_, i) =>
      claim(`f-${i}`, `Fact ${i}: billing exports use region eu-${i} and retry batches.`),
    ),
  );
  ok(await selectContext(db, access, selection(namespace, alice)));
  await compact(access, namespace, alice);
  const before = ok(
    await selectContext(db, access, selection(namespace, alice, { now: T0 + 3 * MINUTE })),
  );
  expect(before.manifest.summary).not.toBeNull();
  const lineage = new Set(
    (await db.orm.select().from(pgSchema.contextSummarySource)).map((row) => row.recordId),
  );
  const target = (await db.orm.select().from(pgSchema.contextRecord)).find(
    (row) =>
      row.workspaceId === namespace.workspaceId && row.status === "current" && lineage.has(row.id),
  )!;
  const replaced = `eu-${target.recordKey.slice(2)} `;
  expect(await allSummaryText()).toContain(replaced);
  const corrected = await correctContext(db, access, {
    namespace,
    requester: alice,
    recordId: target.id,
    body: "Correction: billing exports use region us-east only.",
    now: T0 + 4 * MINUTE,
  });
  expect(corrected.status).toBe("corrected");
  const stale = ok(
    await selectContext(db, access, selection(namespace, alice, { now: T0 + 5 * MINUTE })),
  );
  withinBudget(stale);
  expect(stale.manifest.summary).toBeNull();
  expect(stale.manifest.counts.summariesWithheld).toBe(1);
  expect(stale.pack).toContain("Correction: billing exports use region us-east only.");
  expect(stale.pack).toContain("reported_fact, corrected");
  for (let round = 0; round < 3; round++) {
    await put(
      access,
      namespace,
      alice,
      `doc-more-${round}`,
      Array.from({ length: 20 }, (_, i) =>
        claim(`m-${i}`, `More ${round}-${i}: exporters log batch identifiers for retries.`),
      ),
      { at: T0 + (6 + round) * MINUTE },
    );
    ok(
      await selectContext(
        db,
        access,
        selection(namespace, alice, { now: T0 + (6 + round) * MINUTE }),
      ),
    );
    await compact(
      access,
      namespace,
      alice,
      createFakeContextSummarizer(),
      T0 + (6 + round) * MINUTE + 1,
    );
    const later = ok(
      await selectContext(
        db,
        access,
        selection(namespace, alice, { now: T0 + (7 + round) * MINUTE }),
      ),
    );
    expect(later.pack).toContain("Correction: billing exports use region us-east only.");
    expect(later.manifest.summary).not.toBeNull();
    expect(await allSummaryText()).not.toContain(replaced);
  }
});

test("omitted permitted records stay individually retrievable; foreign or narrowed ones do not", async () => {
  const { namespace, alice, access } = fixture();
  const other = { ...namespace, scopeId: `${namespace.scopeId}-other` };
  access.grant(alice, {
    teamIds: ["team-a"],
    repositories: ["acme/app", "acme/api"],
    channelIds: [],
  });
  await put(
    access,
    namespace,
    alice,
    "doc-many",
    Array.from({ length: 40 }, (_, i) =>
      claim(
        `q-${i}`,
        `Question ${i}: should the exporter retry stage ${i}? ${"context ".repeat(20)}`,
        "unresolved_question",
        2,
      ),
    ),
  );
  await put(
    access,
    namespace,
    alice,
    "doc-api",
    [claim("x", "API-only constraint text", "decision", 5)],
    {
      restriction: { teamIds: ["team-a"], repository: "acme/api" },
    },
  );
  await put(access, other, alice, "doc-other", [claim("o", "Other project fact", "decision", 5)]);
  const result = ok(await selectContext(db, access, selection(namespace, alice)));
  withinBudget(result);
  expect(result.pack).not.toContain("API-only constraint text");
  expect(result.manifest.references.length).toBeGreaterThan(0);
  for (const reference of result.manifest.references) {
    expect(result.pack).toContain(reference.recordId);
    const detail = await retrieveContextDetail(db, access, {
      namespace,
      requester: alice,
      destination: project,
      recordId: reference.recordId,
      repository: "acme/app",
      maxTokens: 50,
      now: T0 + MINUTE,
    });
    expect(detail?.record.id).toBe(reference.recordId);
    expect(estimateContextTokens(detail!.body)).toBeLessThanOrEqual(50);
    expect(detail!.record.body).toBe(detail!.body);
  }
  const rows = await db.orm.select().from(pgSchema.contextRecord);
  const apiRecord = rows.find((row) => row.body === "API-only constraint text")!;
  const otherRecord = rows.find((row) => row.body === "Other project fact")!;
  const detail = (recordId: string, repository = "acme/app") =>
    retrieveContextDetail(db, access, {
      namespace,
      requester: alice,
      destination: project,
      recordId,
      repository,
      maxTokens: 500,
      now: T0 + MINUTE,
    });
  expect(await detail(apiRecord.id)).toBeNull();
  expect(await detail(otherRecord.id)).toBeNull();
  expect((await detail(apiRecord.id, "acme/api"))?.body).toBe("API-only constraint text");
});

test("project, workspace, channel and private scopes never share candidates, summaries or manifests", async () => {
  const { workspaceId, namespace, alice, access } = fixture();
  const otherWorkspace = { ...namespace, workspaceId: `${workspaceId}-x` };
  const bob = { workspaceId: otherWorkspace.workspaceId, userId: alice.userId };
  access.grant(bob, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: [] });
  const channel: ContextNamespace = { workspaceId, scopeKind: "slack_channel", scopeId: "C1" };
  const privateDm: ContextNamespace = {
    workspaceId,
    scopeKind: "user_private",
    scopeId: alice.userId,
  };
  access.grant(alice, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: ["C1"] });
  const many = (tag: string) =>
    Array.from({ length: 30 }, (_, i) =>
      claim(`k-${i}`, `${tag} fact ${i}: export retries with jitter.`),
    );
  await put(access, namespace, alice, "doc-1", many("CANARY-PROJECT"));
  await put(access, otherWorkspace, bob, "doc-1", many("CANARY-WORKSPACE"));
  await put(access, channel, alice, "m-1", many("CANARY-CHANNEL"), {
    kind: "slack_channel_message",
    restriction: { channelId: "C1" },
  });
  await put(access, privateDm, alice, "dm-1", many("CANARY-PRIVATE"), {
    kind: "slack_direct_message",
    restriction: { userId: alice.userId },
  });
  const scopes: [ContextNamespace, ContextRequester, ContextDestination, string][] = [
    [namespace, alice, project, "CANARY-PROJECT"],
    [otherWorkspace, bob, project, "CANARY-WORKSPACE"],
    [channel, alice, { audience: "channel_members", channelId: "C1" }, "CANARY-CHANNEL"],
    [privateDm, alice, { audience: "private_user", userId: alice.userId }, "CANARY-PRIVATE"],
  ];
  const summarizer = createFakeContextSummarizer();
  for (const [scope, requester, destination] of scopes) {
    ok(
      await selectContext(
        db,
        access,
        selection(scope, requester, { destination, repository: undefined }),
      ),
    );
    await compactContext(db, access, summarizer, createContextCapacity(), {
      namespace: scope,
      requester,
      destination,
      settings: SMALL,
      now: T0 + 2 * MINUTE,
    });
  }
  for (const [scope, requester, destination, mine] of scopes) {
    const result = ok(
      await selectContext(
        db,
        access,
        selection(scope, requester, { destination, repository: undefined, now: T0 + 3 * MINUTE }),
      ),
    );
    expect(result.manifest.summary).not.toBeNull();
    expect(result.manifest.scope).toEqual(scope);
    const text = JSON.stringify(result);
    for (const [, , , canary] of scopes) if (canary !== mine) expect(text).not.toContain(canary);
    expect(text).toContain(mine);
  }
  for (const call of summarizer.calls) {
    const tags = new Set(call.records.map((record) => record.body.split(" ")[0]));
    expect(tags.size).toBe(1);
  }
  expect(
    (await selectContext(db, access, selection(privateDm, alice, { destination: project }))).status,
  ).toBe("unavailable");
});

test("forget, delete and revoke before, during and after summarization keep canaries out", async () => {
  const { namespace, alice, access } = fixture();
  const facts = (tag: string) =>
    Array.from({ length: 25 }, (_, i) =>
      claim(`${tag}-${i}`, `${tag} detail ${i}: exporter retries batches.`),
    );
  await put(access, namespace, alice, "doc-keep", facts("KEEP"));
  await put(access, namespace, alice, "doc-before", facts("CANARY-BEFORE"));
  await forgetContextSource(db, access, {
    namespace,
    requester: alice,
    source: { kind: "linear_project_document", id: "doc-before" },
    now: T0 + 1,
  });
  const summarizer = createFakeContextSummarizer();
  summarizer.mode = "condense";
  ok(await selectContext(db, access, selection(namespace, alice)));
  await compact(access, namespace, alice, summarizer);
  expect(JSON.stringify(summarizer.calls)).not.toContain("CANARY-BEFORE");

  await put(access, namespace, alice, "doc-during", facts("CANARY-DURING"), {
    at: T0 + 3 * MINUTE,
  });
  ok(await selectContext(db, access, selection(namespace, alice, { now: T0 + 4 * MINUTE })));
  summarizer.during = async () => {
    await forgetContextSource(db, access, {
      namespace,
      requester: alice,
      source: { kind: "linear_project_document", id: "doc-during" },
      now: T0 + 5 * MINUTE,
    });
  };
  const during = await compact(access, namespace, alice, summarizer, T0 + 5 * MINUTE);
  summarizer.during = null;
  expect(during.status === "ok" && during.outcomes[0]!.status).toBe("invalidated");
  expect(await allSummaryText()).not.toContain("CANARY-DURING");

  await put(access, namespace, alice, "doc-after", facts("CANARY-AFTER"), { at: T0 + 6 * MINUTE });
  await put(access, namespace, alice, "doc-deleted", facts("CANARY-DELETED"), {
    at: T0 + 6 * MINUTE,
  });
  ok(await selectContext(db, access, selection(namespace, alice, { now: T0 + 7 * MINUTE })));
  const built = await compact(access, namespace, alice, summarizer, T0 + 8 * MINUTE);
  expect(built.status === "ok" && built.outcomes[0]!.status).toBe("published");
  expect(await allSummaryText()).toContain("CANARY-AFTER");
  await forgetContextSource(db, access, {
    namespace,
    requester: alice,
    source: { kind: "linear_project_document", id: "doc-after" },
    now: T0 + 9 * MINUTE,
  });
  expect(await allSummaryText()).not.toContain("CANARY-AFTER");
  expect(await allSummaryText()).not.toContain("CANARY-DELETED");
  const replay = await put(access, namespace, alice, "doc-after", facts("CANARY-AFTER"), {
    at: T0 + 6 * MINUTE,
  });
  expect(replay.status).toBe("forgotten");
  ok(await selectContext(db, access, selection(namespace, alice, { now: T0 + 10 * MINUTE })));
  await compact(access, namespace, alice, summarizer, T0 + 11 * MINUTE);
  await invalidateContext(db, {
    namespace,
    source: { kind: "linear_project_document", id: "doc-deleted" },
    reason: "deleted",
    now: T0 + 12 * MINUTE,
  });
  const after = ok(
    await selectContext(db, access, selection(namespace, alice, { now: T0 + 13 * MINUTE })),
  );
  const text = JSON.stringify(after) + (await allSummaryText());
  for (const canary of ["CANARY-BEFORE", "CANARY-DURING", "CANARY-AFTER", "CANARY-DELETED"])
    expect(text).not.toContain(canary);
  expect(after.pack).toContain("KEEP");

  access.grant(alice, { teamIds: ["team-other"], repositories: [], channelIds: [] });
  const revoked = ok(
    await selectContext(db, access, selection(namespace, alice, { now: T0 + 14 * MINUTE })),
  );
  expect(revoked.pack).toBe("");
  expect(revoked.manifest.sources).toEqual([]);
  expect(revoked.manifest.counts).toMatchObject({ candidates: 0, summariesWithheld: 0 });
  access.grants.set(`${alice.workspaceId}\0${alice.userId}`, new Error("directory down"));
  expect(await selectContext(db, access, selection(namespace, alice))).toEqual({
    status: "unavailable",
    reason: "refused",
  });

  await disconnectContext(db, { namespace, actorId: null, now: T0 + 15 * MINUTE });
  const rows = await db.orm.select().from(pgSchema.contextSummary);
  expect(
    rows.filter((row) => row.workspaceId === namespace.workspaceId).map((row) => row.body),
  ).toEqual([""]);
});

test("access revoked during summarization withholds the publish", async () => {
  const { namespace, alice, access } = fixture();
  await put(
    access,
    namespace,
    alice,
    "doc",
    Array.from({ length: 30 }, (_, i) =>
      claim(`k-${i}`, `CANARY-REVOKE ${i}: exporter retries batches with backoff.`),
    ),
  );
  ok(await selectContext(db, access, selection(namespace, alice)));
  const summarizer = createFakeContextSummarizer();
  summarizer.during = async () => {
    access.grant(alice, { teamIds: [], repositories: [], channelIds: [] });
  };
  const run = await compact(access, namespace, alice, summarizer);
  expect(run.status === "ok" && run.outcomes[0]!.status).toBe("invalidated");
  expect(await allSummaryText()).not.toContain("CANARY-REVOKE");
});

test("concurrent compactions, crashed leases and stale publishers never overwrite a newer summary", async () => {
  const { namespace, alice, access } = fixture();
  await put(
    access,
    namespace,
    alice,
    "doc",
    Array.from({ length: 30 }, (_, i) =>
      claim(`k-${i}`, `Fact ${i}: exporter retries batches with backoff.`),
    ),
  );
  ok(await selectContext(db, access, selection(namespace, alice)));
  const [row] = await db.orm
    .select()
    .from(pgSchema.contextSummary)
    .where(eqWorkspace(namespace.workspaceId));
  const crashed = await claimContextCompaction(db, {
    namespace,
    summaryId: row!.id,
    leaseToken: "crashed-worker",
    leaseMs: 120_000,
    now: T0 + MINUTE,
  });
  expect(crashed).not.toBeNull();
  const blocked = await compact(access, namespace, alice, undefined, T0 + 2 * MINUTE);
  expect(blocked).toEqual({ status: "ok", outcomes: [] });

  const later = T0 + 5 * MINUTE;
  const [a, b] = await Promise.all([
    compact(access, namespace, alice, undefined, later),
    compact(access, namespace, alice, undefined, later),
  ]);
  const statuses = [a, b].flatMap((run) =>
    run.status === "ok" ? run.outcomes.map((o) => o.status) : [],
  );
  expect(statuses.filter((status) => status === "published")).toHaveLength(1);
  const published = (
    await db.orm.select().from(pgSchema.contextSummary).where(eqWorkspace(namespace.workspaceId))
  )[0]!;
  expect(published.status).toBe("current");

  const stale = await publishContextSummary(db, {
    namespace,
    summaryId: published.id,
    leaseToken: "crashed-worker",
    version: crashed!.version,
    body: "stale text",
    lineage: [],
    watermark: 0,
    now: later + MINUTE,
  });
  expect(stale.status).toBe("conflict");
  const current = (
    await db.orm.select().from(pgSchema.contextSummary).where(eqWorkspace(namespace.workspaceId))
  )[0]!;
  expect(current.body).toBe(published.body);
  expect(current.version).toBe(published.version);
});

test("a failed, hung or oversized summarizer leaves a bounded extractive pack with no summary", async () => {
  for (const mode of ["fail", "hang", "oversize"] as const) {
    const { namespace, alice, access } = fixture();
    await put(access, namespace, alice, "doc", [
      claim("q", "Question: are retries capped?", "unresolved_question", 3),
      ...Array.from({ length: 30 }, (_, i) =>
        claim(`k-${i}`, `Fact ${i}: exporter retries batches with backoff.`),
      ),
    ]);
    ok(await selectContext(db, access, selection(namespace, alice)));
    const summarizer = createFakeContextSummarizer();
    summarizer.mode = mode;
    const run = await compact(access, namespace, alice, summarizer);
    expect(run.status === "ok" && run.outcomes[0]!.status).toBe("failed");
    const result = ok(
      await selectContext(db, access, selection(namespace, alice, { now: T0 + 3 * MINUTE })),
    );
    withinBudget(result);
    expect(result.manifest.summary).toBeNull();
    expect(result.pack).toContain("Question: are retries capped?");
    expect(result.manifest.references.length).toBeGreaterThan(0);
    expect(result.manifest.compaction).toBe("requested");
  }
}, 20_000);

test("with every lightweight slot busy, selection still works and compaction waits without a runner", async () => {
  const { namespace, alice, access } = fixture();
  const reads = createFakeProjectContextReads();
  await put(
    access,
    namespace,
    alice,
    "doc",
    Array.from({ length: 30 }, (_, i) =>
      claim(`k-${i}`, `Fact ${i}: exporter retries batches with backoff.`),
    ),
  );
  const capacity = createContextCapacity(1);
  const hold = capacity.tryAcquire()!;
  const result = ok(await selectContext(db, access, selection(namespace, alice)));
  withinBudget(result);
  const summarizer = createFakeContextSummarizer();
  const busy = await compact(access, namespace, alice, summarizer, T0 + 2 * MINUTE, capacity);
  expect(busy.status === "ok" && busy.outcomes[0]!.status).toBe("busy");
  expect(summarizer.calls).toEqual([]);
  hold();
  const done = await compact(access, namespace, alice, summarizer, T0 + 3 * MINUTE, capacity);
  expect(done.status === "ok" && done.outcomes[0]!.status).toBe("published");
  expect(capacity.inUse()).toBe(0);
  expect(reads.calls).toEqual([]);
  const forbidden = /from "\.\.\/(runner-[a-z-]+|scheduler|github|loop|questions|intake|slack)/;
  for (const file of ["budget", "select", "compact", "store", "policy"])
    expect(
      await Bun.file(`${import.meta.dir}/../src/project-context/${file}.ts`).text(),
    ).not.toMatch(forbidden);
});

test("requests the requester can't compact never starve one it can", async () => {
  const { namespace, alice, access } = fixture();
  for (let i = 0; i < 6; i++)
    expect(
      await requestContextCompaction(db, {
        namespace,
        audience: "project_members",
        audienceLineage: "project_members@1",
        restriction: { teamIds: [`team-secret-${i}`] },
        now: T0 - 60 * MINUTE + i,
        retryAfterMs: MINUTE,
      }),
    ).toBe("requested");
  await put(
    access,
    namespace,
    alice,
    "doc",
    Array.from({ length: 30 }, (_, i) => claim(`k-${i}`, `Fact ${i}: exporter retries batches.`)),
  );
  ok(await selectContext(db, access, selection(namespace, alice)));
  const run = await compact(access, namespace, alice);
  expect(run).toEqual({
    status: "ok",
    outcomes: [expect.objectContaining({ status: "published" })],
  });
});

test("new records outside the candidate window still reach a summary that already covers the window", async () => {
  const { namespace, alice, access } = fixture();
  const settings = { ...SMALL, candidates: 20 };
  await put(
    access,
    namespace,
    alice,
    "doc-old",
    Array.from({ length: 20 }, (_, i) =>
      claim(`o-${i}`, `Old ${i}: exporter retries batches.`, "reported_fact", 3),
    ),
  );
  const summarizer = createFakeContextSummarizer();
  summarizer.mode = "resolve_everything";
  const run = (now: number) =>
    compactContext(db, access, summarizer, createContextCapacity(), {
      namespace,
      requester: alice,
      destination: project,
      settings,
      now,
    });
  ok(await selectContext(db, access, selection(namespace, alice, { settings })));
  const first = await run(T0 + 2 * MINUTE);
  expect(first.status === "ok" && first.outcomes[0]).toMatchObject({
    status: "published",
    covered: 20,
  });
  await put(
    access,
    namespace,
    alice,
    "doc-new",
    Array.from({ length: 10 }, (_, i) =>
      claim(`n-${i}`, `New ${i}: exporter logs ids.`, "reported_fact", 0),
    ),
    { at: T0 + 3 * MINUTE },
  );
  ok(
    await selectContext(
      db,
      access,
      selection(namespace, alice, { settings, now: T0 + 4 * MINUTE }),
    ),
  );
  const second = await run(T0 + 5 * MINUTE);
  expect(second.status === "ok" && second.outcomes[0]).toMatchObject({
    status: "published",
    covered: 30,
  });
});

test("the extractive summarizer's lineage only names records whose text it kept", async () => {
  const { namespace, alice, access } = fixture();
  for (let round = 0; round < 3; round++) {
    await put(
      access,
      namespace,
      alice,
      `doc-${round}`,
      Array.from({ length: 30 }, (_, i) =>
        claim(`k-${i}`, `Round ${round} fact ${i}: exporter retries batches.`),
      ),
      { at: T0 + round * 10 * MINUTE },
    );
    ok(
      await selectContext(
        db,
        access,
        selection(namespace, alice, { now: T0 + round * 10 * MINUTE + 1 }),
      ),
    );
    await compact(access, namespace, alice, undefined, T0 + round * 10 * MINUTE + 2);
  }
  const [summary] = await db.orm
    .select()
    .from(pgSchema.contextSummary)
    .where(eqWorkspace(namespace.workspaceId));
  const lineage = (await db.orm.select().from(pgSchema.contextSummarySource)).filter(
    (row) => row.summaryId === summary!.id,
  );
  expect(lineage.length).toBe(summary!.covered);
  expect(lineage.length).toBeGreaterThan(0);
  const records = await db.orm.select().from(pgSchema.contextRecord);
  for (const entry of lineage) {
    const record = records.find((row) => row.id === entry.recordId)!;
    expect(summary!.body).toContain(record.body);
  }
});

test("a publish refused for changed lineage drops the trigger and backs off instead of retrying", async () => {
  const { namespace, alice, access } = fixture();
  await put(
    access,
    namespace,
    alice,
    "doc",
    Array.from({ length: 30 }, (_, i) => claim(`k-${i}`, `Fact ${i}: exporter retries batches.`)),
  );
  ok(await selectContext(db, access, selection(namespace, alice)));
  const summarizer = createFakeContextSummarizer();
  summarizer.during = async () => {
    await put(
      access,
      namespace,
      alice,
      "doc",
      Array.from({ length: 30 }, (_, i) =>
        claim(`k-${i}`, `Edited fact ${i}: exporter retries batches.`),
      ),
      { at: T0 + MINUTE },
    );
  };
  const refused = await compact(access, namespace, alice, summarizer, T0 + 2 * MINUTE);
  expect(refused.status === "ok" && refused.outcomes[0]!.status).toBe("invalidated");
  summarizer.during = null;
  const [row] = await db.orm
    .select()
    .from(pgSchema.contextSummary)
    .where(eqWorkspace(namespace.workspaceId));
  expect(row!.requestedAt).toBeNull();
  expect(row!.failure).toBe("lineage_changed");
  const soon = ok(
    await selectContext(db, access, selection(namespace, alice, { now: T0 + 2 * MINUTE + 30_000 })),
  );
  expect(soon.manifest.compaction).toBe("backing_off");
  expect(await compact(access, namespace, alice, summarizer, T0 + 2 * MINUTE + 31_000)).toEqual({
    status: "ok",
    outcomes: [],
  });
  const later = ok(
    await selectContext(db, access, selection(namespace, alice, { now: T0 + 4 * MINUTE })),
  );
  expect(later.manifest.compaction).toBe("requested");
  const rebuilt = await compact(access, namespace, alice, summarizer, T0 + 4 * MINUTE + 1);
  expect(rebuilt.status === "ok" && rebuilt.outcomes[0]!.status).toBe("published");
});
