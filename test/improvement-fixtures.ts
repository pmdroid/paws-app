import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  beginRetroCollection,
  createRetro,
  freezeRetroInput,
  insertQueuedItem,
  listReviewFindings,
  migrate,
  openDatabase,
  publishRetro,
  putWorkspaceUser,
  recordRetroEvidence,
  recordReviewFindings,
  saveRetroSettingsRevision,
  startRetroAttempt,
  syncWorkspaceMember,
  writeRetroArtifact,
  sqliteDb,
  type Db,
} from "../src/db";
import {
  createFakeIssueLookup,
  createImprovementsHttp,
  ingestDailyFindings,
} from "../src/improvements";
import { createRetroReviewHttp, retroReaderAccessSteps } from "../src/retros";
import { type WorkspacePrincipal } from "../src/workspace";
import { tempStore } from "./pglite";

export type Json = ReturnType<typeof JSON.parse>;

export const A = "acme/a";
export const B = "acme/b";
export const START = Date.UTC(2026, 9, 22);
export const END = Date.UTC(2026, 9, 29);
export const ALL = ["session-a", "session-b"];
export const ONLY_A = ["session-a"];

type Extra = Partial<Parameters<typeof createImprovementsHttp>[0]>;

export async function world(extra: Extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-improvement-review-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  return { ...(await worldOn(sqliteDb(db), root, extra)), db };
}

export async function worldPg(extra: Extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-improvement-review-"));
  const { db, close } = await tempStore();
  return { ...(await worldOn(db, root, extra)), db, close };
}

async function worldOn(db: Db, root: string, extra: Extra) {
  await db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.workspace).values([
        { id: "ws", linearOrganizationId: "org", name: "Kyku", createdAt: 0 },
        { id: "other", linearOrganizationId: "org-2", name: "Other", createdAt: 0 },
      ]),
    );
    yield* q.exec(
      q.orm.insert(q.t.workspaceRepository).values([
        { workspaceId: "ws", repository: A, teamId: "team-a" },
        { workspaceId: "ws", repository: B, teamId: "team-b" },
      ]),
    );
  });
  const people: Record<string, WorkspacePrincipal> = {};
  for (const [name, role, teams] of [
    ["admin", "admin", ["team-a", "team-b"]],
    ["ada", "member", ["team-a"]],
    ["bea", "member", ["team-a"]],
  ] as const) {
    const userId = await putWorkspaceUser(db, {
      id: `user-${name}`,
      linearUserId: `linear-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId,
      role,
      active: true,
      teamIds: teams,
      now: 1,
    });
    people[name] = { workspaceId: "ws", userId, role, authenticatedAt: 1, teamIds: teams };
  }
  for (const [suffix, repository, team] of [
    ["a", A, "team-a"],
    ["b", B, "team-b"],
  ] as const) {
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.linearSession).values({
          sessionId: `session-${suffix}`,
          organizationId: "org",
          oauthClientId: "client",
          appUserId: "app",
          teamId: team,
          installationObservedAt: 1,
          createdAt: 0,
        }),
      ),
    );
    await insertQueuedItem(db, {
      id: `item-${suffix}`,
      sessionKey: `session-${suffix}`,
      now: START + 1,
    });
    const [owner, repo] = repository.split("/");
    await db.run((q) =>
      q.exec(
        q.orm
          .insert(q.t.workItemRepository)
          .values({ itemId: `item-${suffix}`, owner: owner!, repo: repo!, remoteUrl: "git@x" }),
      ),
    );
  }
  const retro = await publishTwoRepositoryRetro(db, root);
  const lookup = createFakeIssueLookup([
    { id: "issue-open", identifier: "PAS-60", url: null, teamId: "team-a", state: "open" },
    { id: "issue-closed", identifier: "PAS-61", url: null, teamId: "team-a", state: "closed" },
    { id: "issue-b", identifier: "OPS-7", url: null, teamId: "team-b", state: "open" },
  ]);
  let clock = END + 1_000;
  const now = () => ++clock;
  const improvements = createImprovementsHttp({
    store: db,
    lookup: lookup.lookup,
    retroEvidence: function* (q, principal, sessionIds, retroId) {
      return (
        (yield* retroReaderAccessSteps(q, root, principal, sessionIds, retroId))?.readable ?? null
      );
    },
    now,
    ...extra,
  });
  const retros = createRetroReviewHttp({ store: db, artifactRoot: root, now });
  const call = async (
    handler: typeof improvements,
    who: string,
    path: string,
    body?: unknown,
    sessions: readonly string[] = who === "admin" ? ALL : ONLY_A,
  ) => {
    const response = await handler(
      new Request(`http://paws.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      people[who]!,
      sessions,
    );
    return { status: response!.status, headers: response!.headers, response: response! };
  };
  const api = async (who: string, path: string, body?: unknown, sessions?: readonly string[]) => {
    const result = await call(improvements, who, path, body, sessions);
    return { ...result, body: (await result.response.json()) as Json };
  };
  const retroApi = (who: string, path: string, sessions?: readonly string[]) =>
    call(retros, who, path, undefined, sessions);
  return { root, people, lookup, api, retroApi, retro, now, improvements };
}

async function publishTwoRepositoryRetro(db: Db, root: string) {
  const { revision } = await saveRetroSettingsRevision(db, {
    workspaceId: "ws",
    prompt: "Review {{period}}.\n\n{{digest}}",
    agentProfile: { agent: "codex" },
    repositories: [A, B],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: 1 },
    schedule: {},
    createdBy: "user-admin",
    now: 1,
  });
  await createRetro(db, {
    id: "r1",
    workspaceId: "ws",
    windowStart: START,
    windowEnd: END,
    origin: "manual",
    settingsRevision: revision,
    now: END,
  });
  await beginRetroCollection(db, { retroId: "r1", now: END });
  const records = [
    ["ev-a1", "item-a", "PAS-1", A],
    ["ev-a2", "item-a", "PAS-1", A],
    ["ev-b1", "item-b", "OPS-1", B],
    ["ev-b2", "item-b", "OPS-1", B],
  ] as const;
  await recordRetroEvidence(
    db,
    "r1",
    records.map(([evidenceId, itemId, , repository]) => ({
      evidenceId,
      repository,
      sourceKind: "question",
      sourceRef: `question/${evidenceId}`,
      occurredAt: START + 10,
      excerpt: `Answered question in ${repository} for ${itemId}`,
    })),
  );
  const digest = {
    version: 1,
    retroId: "r1",
    sessions: [{ itemId: "item-a" }, { itemId: "item-b" }],
    records: records.map(([evidenceId, itemId, identifier, repository]) => ({
      evidenceId,
      itemId,
      identifier,
      repository,
    })),
  };
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const digestRecord = await writeRetroArtifact(db, root, {
    retroId: "r1",
    kind: "digest",
    bytes: encode(digest),
    now: END,
  });
  await writeRetroArtifact(db, root, {
    retroId: "r1",
    kind: "manifest",
    bytes: encode({}),
    now: END,
  });
  await writeRetroArtifact(db, root, {
    retroId: "r1",
    kind: "prompt",
    bytes: new TextEncoder().encode(`Review.\n${JSON.stringify(digest)}`),
    now: END,
  });
  await freezeRetroInput(db, {
    retroId: "r1",
    endCursors: { [A]: 10, [B]: 10 },
    now: END,
  });
  const { attempt } = (await startRetroAttempt(db, {
    retroId: "r1",
    owner: "o",
    now: END,
    leaseMs: 60_000,
  }))!;
  const counts = (identifier: string) => ({
    sessions: 1,
    events: 2,
    context: 0,
    byKind: { question: 2 },
    byWorkItem: [{ identifier, events: 2 }],
  });
  const pattern = (itemId: string, repository: string, ids: string[], identifier: string) => ({
    itemId,
    repository,
    area: "Git recovery",
    title: `Recovery repeats in ${repository}`,
    explanation: `People answered the same push question in ${repository}.`,
    hypothesis: "A durable recovery removes the question.",
    expectedBenefit: "Fewer questions.",
    evidenceIds: ids,
    action: { step: "Issue", change: "Make branch-tip recovery durable." },
    verification: "No push-recovery question in the next two retros.",
    existingIssues: [],
    counts: counts(identifier),
    priorWork: [],
  });
  const items = [
    pattern("p1", A, ["ev-a1", "ev-a2"], "PAS-1"),
    pattern("p2", B, ["ev-b1", "ev-b2"], "OPS-1"),
  ];
  const report = {
    version: 1,
    retroId: "r1",
    digestSha256: digestRecord.sha256,
    generation: "model",
    windows: [
      { repository: A, start: START, end: END },
      { repository: B, start: START, end: END },
    ],
    numbers: [{ key: "sessions", label: "sessions", value: 2 }],
    items,
    workedWell: [
      {
        repository: B,
        observation: "Review caught gaps in acme/b.",
        evidenceIds: ["ev-b1"],
        counts: counts("OPS-1"),
      },
    ],
    notes: [],
  };
  const published = await publishRetro(db, {
    retroId: "r1",
    attempt,
    owner: "o",
    result: report,
    items: items.map((item) => ({
      itemId: item.itemId,
      repository: item.repository,
      area: item.area,
      actionStep: "issue" as const,
      title: item.title,
      problem: item.explanation,
      proposedChange: item.action.change,
      verificationCriterion: item.verification,
      evidenceIds: item.evidenceIds,
    })),
    now: END,
  });
  if (!published.ok) throw new Error(published.reason);
  const byItem = Object.fromEntries(
    published.items.map((item) => [item.itemId, item.improvementId]),
  );
  return { a: byItem["p1"]!, b: byItem["p2"]! };
}

export async function seedDaily(db: ReturnType<typeof openDatabase>) {
  await recordReviewFindings(sqliteDb(db), {
    itemId: "item-a",
    repository: A,
    head: "a".repeat(40),
    seenAt: END,
    reviewed: [],
    findings: ["src/a.ts:1", "src/b.ts:2"].map((location) => ({
      review: "independent",
      severity: "P2" as const,
      location,
      text: `Problem at ${location}`,
      bugClass: "timing",
      why: "pre-existing" as const,
    })),
  });
  const findings = (await listReviewFindings(sqliteDb(db))).sort((x, y) => x.id - y.id);
  const run = randomUUID();
  db.run(
    "INSERT INTO finding_group_run(id,workspace_id,day,started_at,fingerprint,status) VALUES(?,?,?,?,?,'completed')",
    [run, "ws", run, 1, "x"],
  );
  const groupId = randomUUID();
  db.run(
    `INSERT INTO finding_group(id,workspace_id,repository,team_id,title,summary,scope,member_ids,created_at,run_id,status)
     VALUES(?,?,?,?,?,?,?,?,?,?,'open')`,
    [
      groupId,
      "ws",
      A,
      "team-a",
      "Shared fix",
      "Summary",
      "src",
      JSON.stringify(findings.map((f) => f.id)),
      1,
      run,
    ],
  );
  await ingestDailyFindings(sqliteDb(db), "ws", { now: END });
  return { groupId, findings };
}

export const accept = (
  version = 1,
  intent: unknown = { kind: "create", teamId: "team-a" },
  extra: Record<string, unknown> = {},
) => ({
  expectedVersion: version,
  decision: { kind: "accept", proposalVersion: 1, intent, ...extra },
});
export const reject = (version = 1, reason = "Not recurring") => ({
  expectedVersion: version,
  decision: { kind: "reject", reason },
});
