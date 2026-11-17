import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listContextAudit, type Db } from "../src/db";
import {
  CONTEXT_QUERY_LIMITS,
  CONTEXT_RETENTION,
  correctContext,
  createFakeContextAccess,
  disconnectContext,
  forgetContextSource,
  ingestContext,
  inspectContext,
  invalidateContext,
  queryContext,
  readdContext,
  reconnectContext,
  sweepContext,
  type ContextClassification,
  type ContextNamespace,
  type ContextRequester,
  type ContextSourceRevision,
} from "../src/project-context";
import { tempStore } from "./pglite";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-17T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

function ids() {
  seq++;
  const workspaceId = `ws-${seq}`;
  const projectId = `project-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  return { workspaceId, projectId, namespace, alice };
}

const project = { audience: "project_members" } as const;

function source(
  id: string,
  revisionAt: number,
  overrides: Partial<ContextSourceRevision> = {},
): ContextSourceRevision {
  return {
    kind: "linear_project_document",
    id,
    url: `https://linear.app/d/${id}`,
    revision: new Date(revisionAt).toISOString(),
    revisionAt,
    actorId: "creator-1",
    restriction: { teamIds: ["team-pas"] },
    ...overrides,
  };
}

const observation = (
  key: string,
  body: string,
  classification: ContextClassification = "reported_fact",
) => ({
  key,
  layer: "observation" as const,
  classification,
  importance: 2,
  body,
});

async function bodies(
  access: ReturnType<typeof createFakeContextAccess>,
  namespace: ContextNamespace,
  requester: ContextRequester,
  now = T0,
) {
  const result = await queryContext(db, access, {
    namespace,
    requester,
    destination: project,
    limit: 50,
    maxBytes: 32_000,
    now,
  });
  if (result.status !== "ok") throw new Error("query refused");
  return result.records.map((record) => record.body);
}

test("project A/B and workspace A/B never share records, even with matching names and ids", async () => {
  const a = ids();
  const access = createFakeContextAccess();
  const bProject: ContextNamespace = { ...a.namespace, scopeId: `${a.projectId}-b` };
  const otherWorkspace: ContextNamespace = { ...a.namespace, workspaceId: `${a.workspaceId}-b` };
  const otherRequester = { workspaceId: otherWorkspace.workspaceId, userId: a.alice.userId };
  for (const requester of [a.alice, otherRequester])
    access.grant(requester, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  await ingestContext(db, access, {
    namespace: a.namespace,
    requester: a.alice,
    source: source("doc-shared", T0),
    claims: [observation("same-key", "CANARY-A only for project A")],
    now: T0,
  });
  await ingestContext(db, access, {
    namespace: bProject,
    requester: a.alice,
    source: source("doc-shared", T0),
    claims: [observation("same-key", "project B text")],
    now: T0,
  });
  expect(await bodies(access, a.namespace, a.alice)).toEqual(["CANARY-A only for project A"]);
  expect(await bodies(access, bProject, a.alice)).toEqual(["project B text"]);
  expect(await bodies(access, otherWorkspace, otherRequester)).toEqual([]);
  const crossWorkspace = await queryContext(db, access, {
    namespace: a.namespace,
    requester: otherRequester,
    destination: project,
    limit: 10,
    maxBytes: 10_000,
    now: T0,
  });
  expect(crossWorkspace).toEqual({ status: "refused" });
});

test("Slack-shaped channel and private namespaces stay separate and never feed project memory", async () => {
  const { workspaceId, namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: ["C1"] });
  const channel: ContextNamespace = { workspaceId, scopeKind: "slack_channel", scopeId: "C1" };
  const dm: ContextNamespace = { workspaceId, scopeKind: "user_private", scopeId: alice.userId };
  const channelStored = await ingestContext(db, access, {
    namespace: channel,
    requester: alice,
    source: source("ts-1", T0, { kind: "slack_channel_message", restriction: { channelId: "C1" } }),
    claims: [observation("k", "CANARY-CHANNEL")],
    now: T0,
  });
  expect(channelStored.status).toBe("stored");
  const dmStored = await ingestContext(db, access, {
    namespace: dm,
    requester: alice,
    source: source("ts-2", T0, {
      kind: "slack_direct_message",
      restriction: { userId: alice.userId },
    }),
    claims: [observation("k", "CANARY-DM")],
    now: T0,
  });
  expect(dmStored.status).toBe("stored");
  const promoted = await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("ts-2", T0, {
      kind: "slack_direct_message",
      restriction: { userId: alice.userId },
    }),
    claims: [observation("k", "CANARY-DM")],
    now: T0,
  });
  expect(promoted).toEqual({ status: "refused" });
  expect(await bodies(access, namespace, alice)).toEqual([]);

  const channelRead = await queryContext(db, access, {
    namespace: channel,
    requester: alice,
    destination: { audience: "channel_members", channelId: "C1" },
    limit: 10,
    maxBytes: 1_000,
    now: T0,
  });
  expect(channelRead.status === "ok" && channelRead.records.map((r) => r.body)).toEqual([
    "CANARY-CHANNEL",
  ]);
  const dmRead = await queryContext(db, access, {
    namespace: dm,
    requester: alice,
    destination: { audience: "private_user", userId: alice.userId },
    limit: 10,
    maxBytes: 1_000,
    now: T0,
  });
  expect(dmRead.status === "ok" && dmRead.records.map((r) => r.body)).toEqual(["CANARY-DM"]);
  const bob = { workspaceId, userId: "bob" };
  access.grant(bob, { teamIds: ["team-pas"], repositories: [], channelIds: ["C1"] });
  expect(
    await queryContext(db, access, {
      namespace: dm,
      requester: bob,
      destination: { audience: "private_user", userId: alice.userId },
      limit: 10,
      maxBytes: 1_000,
      now: T0,
    }),
  ).toEqual({ status: "refused" });
  expect(
    await queryContext(db, access, {
      namespace: dm,
      requester: alice,
      destination: project,
      limit: 10,
      maxBytes: 1_000,
      now: T0,
    }),
  ).toEqual({ status: "refused" });
});

test("a project member without access to a narrower source sees nothing about it", async () => {
  const { workspaceId, namespace, alice } = ids();
  const access = createFakeContextAccess();
  const bob = { workspaceId, userId: `bob-${seq}` };
  access.grant(alice, {
    teamIds: ["team-pas", "team-private"],
    repositories: ["o/secret"],
    channelIds: [],
  });
  access.grant(bob, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("doc-open", T0),
    claims: [observation("open", "Open project fact")],
    now: T0,
  });
  const narrow = await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("item-1", T0, {
      kind: "paws_work_item",
      url: "https://linear.app/i/CANARY-URL",
      restriction: { teamIds: ["team-private"], repository: "o/secret" },
    }),
    claims: [observation("narrow", "CANARY-PRIVATE decision", "decision")],
    now: T0,
  });
  expect(narrow.status).toBe("stored");
  const bobIngest = await ingestContext(db, access, {
    namespace,
    requester: bob,
    source: source("item-2", T0, {
      kind: "paws_work_item",
      restriction: { teamIds: ["team-private"] },
    }),
    claims: [observation("narrow", "bob cannot store this")],
    now: T0,
  });
  expect(bobIngest).toEqual({ status: "refused" });

  const bobView = await queryContext(db, access, {
    namespace,
    requester: bob,
    destination: project,
    limit: 50,
    maxBytes: 32_000,
    now: T0,
  });
  expect(JSON.stringify(bobView)).not.toContain("CANARY");
  expect(bobView.status === "ok" && bobView.records.map((r) => r.body)).toEqual([
    "Open project fact",
  ]);
  expect(await bodies(access, namespace, alice)).toContain("CANARY-PRIVATE decision");

  const aliceView = await queryContext(db, access, {
    namespace,
    requester: alice,
    destination: project,
    limit: 50,
    maxBytes: 32_000,
    now: T0,
  });
  const privateId =
    aliceView.status === "ok"
      ? aliceView.records.find((r) => r.source.kind === "paws_work_item")!.id
      : "";
  const destination = project;
  expect(
    await inspectContext(db, access, {
      namespace,
      requester: bob,
      destination,
      recordId: privateId,
      now: T0,
    }),
  ).toBeNull();
  expect(
    await inspectContext(db, access, {
      namespace,
      requester: bob,
      destination,
      recordId: "missing",
      now: T0,
    }),
  ).toBeNull();
  expect(
    await forgetContextSource(db, access, {
      namespace,
      requester: bob,
      source: { kind: "paws_work_item", id: "item-1" },
      now: T0,
    }),
  ).toEqual({ status: "refused" });
  expect(
    await correctContext(db, access, {
      namespace,
      requester: bob,
      recordId: privateId,
      body: "rewritten",
      now: T0,
    }),
  ).toEqual({ status: "refused" });

  const unknown = await queryContext(db, access, {
    namespace,
    requester: alice,
    destination: { audience: "everyone" },
    limit: 50,
    maxBytes: 32_000,
    now: T0,
  });
  expect(unknown).toEqual({ status: "refused" });
  const stranger = { workspaceId, userId: "stranger" };
  const strangerView = await queryContext(db, access, {
    namespace,
    requester: stranger,
    destination: project,
    limit: 50,
    maxBytes: 32_000,
    now: T0,
  });
  expect(strangerView).toEqual({ status: "ok", generation: 0, records: [], bytes: 0 });
  access.grants.set(`${workspaceId}\0${alice.userId}`, new Error("Linear is down"));
  expect(await bodies(access, namespace, alice)).toEqual([]);
});

test("secrets are redacted before storage", async () => {
  const { namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("doc-secret", T0),
    claims: [observation("s", "Deploy with token: lin_api_abcdefghijklmnopqrstuvwx today")],
    now: T0,
  });
  const [body] = await bodies(access, namespace, alice);
  expect(body).not.toContain("lin_api_");
  expect(body).toContain("[redacted]");
});

test("a correction supersedes the old claim and cannot turn an inference into a decision", async () => {
  const { namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const ingest = (revisionAt: number) =>
    ingestContext(db, access, {
      namespace,
      requester: alice,
      source: source("doc-c", revisionAt),
      claims: [observation("guess", "The cache probably lives a day", "inference")],
      now: revisionAt,
    });
  await ingest(T0);
  const before = await queryContext(db, access, {
    namespace,
    requester: alice,
    destination: project,
    limit: 5,
    maxBytes: 5_000,
    now: T0,
  });
  const id = before.status === "ok" ? before.records[0]!.id : "";
  expect(
    await correctContext(db, access, {
      namespace,
      requester: alice,
      recordId: id,
      body: "It lives an hour",
      classification: "decision",
      now: T0 + 1,
    }),
  ).toEqual({ status: "upgrade_refused" });
  const corrected = await correctContext(db, access, {
    namespace,
    requester: alice,
    recordId: id,
    body: "The cache lives an hour",
    now: T0 + 2,
  });
  expect(corrected).toMatchObject({
    status: "corrected",
    record: { classification: "inference", version: 2, supersedes: id, correctedBy: alice.userId },
  });
  await ingest(T0);
  await ingest(T0 + 10);
  expect(await bodies(access, namespace, alice, T0 + 11)).toEqual(["The cache lives an hour"]);
  const inspection = await inspectContext(db, access, {
    namespace,
    requester: alice,
    destination: project,
    recordId: corrected.status === "corrected" ? corrected.record.id : "",
    now: T0 + 11,
  });
  expect(inspection?.versions.map((v) => [v.version, v.status])).toEqual([
    [2, "current"],
    [1, "superseded"],
  ]);
});

test("forget is a tombstone that new revisions and replays respect until an authorized re-add", async () => {
  const { namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const ingest = (revisionAt: number, body: string) =>
    ingestContext(db, access, {
      namespace,
      requester: alice,
      source: source("doc-f", revisionAt),
      claims: [observation("k", body)],
      now: revisionAt,
    });
  await ingest(T0, "FORGET-ME v1");
  const forgotten = await forgetContextSource(db, access, {
    namespace,
    requester: alice,
    source: { kind: "linear_project_document", id: "doc-f" },
    now: T0 + 1,
  });
  expect(forgotten.status).toBe("forgotten");
  if (forgotten.status !== "forgotten") return;
  expect(forgotten.invalidation.records).toEqual([
    expect.objectContaining({ sourceId: "doc-f", version: 1, reason: "forgotten" }),
  ]);
  expect(forgotten.invalidation.scopes[0]!.generation).toBeGreaterThan(1);
  expect(await ingest(T0, "FORGET-ME v1")).toEqual({ status: "forgotten" });
  expect(await ingest(T0 + DAY, "FORGET-ME v2")).toEqual({ status: "forgotten" });
  expect(await bodies(access, namespace, alice, T0 + DAY)).toEqual([]);
  const audit = await listContextAudit(db, namespace, 10);
  expect(JSON.stringify(audit)).not.toContain("FORGET-ME");
  expect(audit.map((entry) => entry.action)).toEqual(["ingest", "forgotten"]);

  const bob = { workspaceId: namespace.workspaceId, userId: "bob-f" };
  expect(
    await readdContext(db, access, {
      namespace,
      requester: bob,
      source: { kind: "linear_project_document", id: "doc-f" },
      now: T0 + DAY,
    }),
  ).toBe(false);
  expect(
    await readdContext(db, access, {
      namespace,
      requester: alice,
      source: { kind: "linear_project_document", id: "doc-f" },
      now: T0 + DAY,
    }),
  ).toBe(true);
  expect((await ingest(T0 + DAY, "FORGET-ME v2")).status).toBe("stored");
  expect(await bodies(access, namespace, alice, T0 + DAY)).toEqual(["FORGET-ME v2"]);
});

test("source edits, deletion, revocation and expiry invalidate records and replays cannot resurrect them", async () => {
  const { namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const ingest = (id: string, revisionAt: number, claims: ReturnType<typeof observation>[]) =>
    ingestContext(db, access, {
      namespace,
      requester: alice,
      source: source(id, revisionAt),
      claims,
      now: revisionAt,
    });
  await ingest("doc-e", T0, [observation("a", "kept"), observation("b", "removed later")]);
  const edited = await ingest("doc-e", T0 + 10, [
    observation("a", "kept"),
    observation("c", "new line"),
  ]);
  expect(edited.status === "stored" && edited.invalidation.records.map((r) => r.reason)).toEqual([
    "edited",
  ]);
  expect(await ingest("doc-e", T0, [observation("b", "removed later")])).toEqual({
    status: "stale",
  });
  expect((await bodies(access, namespace, alice, T0 + 10)).sort()).toEqual(["kept", "new line"]);

  await ingest("doc-d", T0, [observation("x", "DELETED-DOC")]);
  const deleted = await invalidateContext(db, {
    namespace,
    source: { kind: "linear_project_document", id: "doc-d" },
    reason: "deleted",
    now: T0 + 20,
  });
  expect(deleted?.records.map((r) => r.reason)).toEqual(["deleted"]);
  expect(await ingest("doc-d", T0, [observation("x", "DELETED-DOC")])).toEqual({ status: "stale" });

  await ingest("doc-r", T0, [observation("x", "REVOKED-DOC")]);
  await invalidateContext(db, {
    namespace,
    source: { kind: "linear_project_document", id: "doc-r" },
    reason: "revoked",
    now: T0 + 20,
  });
  expect(await ingest("doc-r", T0, [observation("x", "REVOKED-DOC")])).toEqual({ status: "stale" });
  expect((await ingest("doc-r", T0 + 30, [observation("x", "REVOKED-DOC v2")])).status).toBe(
    "stored",
  );

  const visible = await bodies(access, namespace, alice, T0 + 30);
  expect(visible).not.toContain("DELETED-DOC");
  expect(visible).not.toContain("REVOKED-DOC");
  expect(visible).toContain("REVOKED-DOC v2");

  const later = T0 + CONTEXT_RETENTION.retentionMs + 100;
  expect(await bodies(access, namespace, alice, later)).toEqual([]);
  const expiredView = await queryContext(db, access, {
    namespace,
    requester: alice,
    destination: project,
    limit: 50,
    maxBytes: 32_000,
    now: T0 + 30,
  });
  const expiredId = expiredView.status === "ok" ? expiredView.records[0]!.id : "";
  expect(
    await correctContext(db, access, {
      namespace,
      requester: alice,
      recordId: expiredId,
      body: "revived",
      now: later,
    }),
  ).toEqual({ status: "refused" });
  expect(
    await inspectContext(db, access, {
      namespace,
      requester: alice,
      destination: project,
      recordId: expiredId,
      now: later,
    }),
  ).toBeNull();
  const swept = await sweepContext(db, later);
  expect(swept.invalidation.records.length).toBeGreaterThanOrEqual(3);
  expect(swept.invalidation.records.every((r) => r.reason === "expired")).toBe(true);
  expect(await bodies(access, namespace, alice, later)).toEqual([]);
  const reread = await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("doc-e", T0 + 10),
    claims: [observation("a", "kept")],
    now: later,
  });
  expect(reread.status).toBe("stored");
  expect(await bodies(access, namespace, alice, later)).toEqual(["kept"]);

  const purged = await sweepContext(db, later + CONTEXT_RETENTION.historyMs + 1);
  expect(purged.purged).toBeGreaterThan(0);
  expect(await ingest("doc-d", T0, [observation("x", "DELETED-DOC")])).toEqual({ status: "stale" });
});

test("scope disconnect invalidates everything and blocks ingest until reconnected", async () => {
  const { namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const ingest = (revisionAt: number) =>
    ingestContext(db, access, {
      namespace,
      requester: alice,
      source: source("doc-s", revisionAt),
      claims: [observation("k", "scoped")],
      now: revisionAt,
    });
  await ingest(T0);
  const disconnected = await disconnectContext(db, { namespace, actorId: "admin", now: T0 + 1 });
  expect(disconnected?.records.map((r) => r.reason)).toEqual(["disconnected"]);
  expect(await ingest(T0 + 5)).toEqual({ status: "disconnected" });
  expect(await bodies(access, namespace, alice, T0 + 5)).toEqual([]);
  await reconnectContext(db, { namespace, actorId: "admin", now: T0 + 6 });
  expect((await ingest(T0)).status).toBe("stored");
  expect(await bodies(access, namespace, alice, T0 + 6)).toEqual(["scoped"]);
});

test("queries bound records and bytes, and restricted records never starve visible ones", async () => {
  const { workspaceId, namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const hidden = { workspaceId, userId: "writer-hidden" };
  access.grant(hidden, { teamIds: ["team-hidden"], repositories: [], channelIds: [] });
  for (let index = 0; index < 6; index++)
    await ingestContext(db, access, {
      namespace,
      requester: alice,
      source: source(`visible-${index}`, T0),
      claims: Array.from({ length: 10 }, (_, n) => ({
        ...observation(`v${n}`, `visible ${index}-${n} ${"x".repeat(100)}`),
        importance: 1,
      })),
      now: T0,
    });
  for (let index = 0; index < 6; index++)
    await ingestContext(db, access, {
      namespace,
      requester: hidden,
      source: source(`hidden-${index}`, T0, { restriction: { teamIds: ["team-hidden"] } }),
      claims: Array.from({ length: 40 }, (_, n) => ({
        ...observation(`h${n}`, `hidden ${index}-${n}`),
        importance: 5,
      })),
      now: T0 + 1,
    });
  const over = await queryContext(db, access, {
    namespace,
    requester: alice,
    destination: project,
    limit: 10_000,
    maxBytes: 10_000_000,
    now: T0 + 2,
  });
  if (over.status !== "ok") throw new Error("refused");
  expect(over.records).toHaveLength(CONTEXT_QUERY_LIMITS.records);
  expect(over.records.every((record) => record.body.startsWith("visible "))).toBe(true);
  expect(over.bytes).toBeLessThanOrEqual(CONTEXT_QUERY_LIMITS.bytes);
  expect(CONTEXT_QUERY_LIMITS.candidates).toBeLessThan(240);

  const small = await queryContext(db, access, {
    namespace,
    requester: hidden,
    destination: project,
    limit: 10_000,
    maxBytes: 300,
    now: T0 + 2,
  });
  if (small.status !== "ok") throw new Error("refused");
  expect(small.bytes).toBeLessThanOrEqual(300);
  expect(small.records.length).toBeGreaterThan(0);
  const many = await queryContext(db, access, {
    namespace,
    requester: hidden,
    destination: project,
    limit: 10_000,
    maxBytes: 10_000_000,
    now: T0 + 2,
  });
  expect(many.status === "ok" && many.records.length).toBe(CONTEXT_QUERY_LIMITS.records);
});

test("the cap evicts the least important records and a re-read stays within it", async () => {
  const { namespace, alice } = ids();
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const base = Array.from({ length: 40 }, (_, n) => ({
    ...observation(`k${n}`, `low ${n}`),
    importance: 0,
  }));
  for (let index = 0; index < 50; index++)
    await ingestContext(db, access, {
      namespace,
      requester: alice,
      source: source(`cap-${index}`, T0),
      claims: base,
      now: T0 + index,
    });
  const result = await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("cap-important", T0),
    claims: Array.from({ length: 40 }, (_, n) => ({
      ...observation(`i${n}`, `important ${n}`),
      importance: 5,
    })),
    now: T0 + 100,
  });
  expect(result.status === "stored" && result.invalidation.records.length).toBe(40);
  expect(
    result.status === "stored" &&
      result.invalidation.records.every((record) => record.reason === "retention"),
  ).toBe(true);
  const sample = await queryContext(db, access, {
    namespace,
    requester: alice,
    destination: project,
    limit: 1,
    maxBytes: 1_000,
    now: T0 + 100,
  });
  expect(sample.status === "ok" && sample.records[0]!.body).toStartWith("important ");
  expect(
    result.status === "stored" &&
      new Set(result.invalidation.records.map((record) => record.sourceId)),
  ).toEqual(new Set(["cap-0"]));
  const reread = await ingestContext(db, access, {
    namespace,
    requester: alice,
    source: source("cap-0", T0),
    claims: base,
    now: T0 + 101,
  });
  expect(reread.status === "stored" && reread.inserted).toBe(40);
  expect(
    reread.status === "stored" &&
      reread.invalidation.records.filter((record) => record.reason === "retention").length,
  ).toBe(40);
});

test("the source and store path imports no runner placement, reservation or scheduling", () => {
  const dir = join(import.meta.dir, "../src/project-context");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text).not.toMatch(/from "\.\.\/(runner-|scheduler|loop)/);
  }
});
