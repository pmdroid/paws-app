import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  contextSummaryLineage,
  listContextSummaries,
  type ContextNamespace,
  type Db,
} from "../src/db";
import {
  CONTEXT_DREAM_PROMPT,
  MEMORY_INDEX_HEADER,
  createFakeContextAccess,
  createFakeContextDreamHelper,
  createFakeProjectContextReads,
  createProjectSessionContext,
  dreamProjectContexts,
  forgetContextRecord,
  ingestLinearProjectContext,
  recordWorkItemContext,
  type FakeContextDreamHelper,
  type FakeDreamEntry,
} from "../src/project-context";
import { insertWorkItem, seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

async function fixture() {
  seq++;
  const workspaceId = `org-dream-${seq}`;
  const projectId = `project-dream-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const alice = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  const reads = createFakeProjectContextReads();
  reads.projects.set(projectId, {
    id: projectId,
    name: "Exports",
    url: `https://linear.app/p/${projectId}`,
    revision: "p1",
    revisionAt: T0,
    teamIds: ["team-a"],
    content: "Exports ship as CSV.",
  });
  await ingestLinearProjectContext(db, access, reads, {
    workspaceId,
    projectId,
    requester: alice,
    now: T0,
  });
  const itemId = `dream-item-${seq}`;
  const sessionId = `dream-session-${seq}`;
  await insertWorkItem(db, itemId, T0);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: `ws-dream-${seq}`,
        linearOrganizationId: workspaceId,
        name: "Acme",
        createdAt: T0,
      }),
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId,
        organizationId: workspaceId,
        creatorId: alice.userId,
        createdAt: T0,
      }),
    (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ sessionKey: sessionId, linearProjectId: projectId })
        .where(eq(q.t.workItem.id, itemId)),
  );
  let revision = 0;
  const remember = async (bodies: readonly string[], now: number) => {
    revision++;
    const outcome = await recordWorkItemContext(db, access, {
      namespace,
      requester: alice,
      workItemId: `${itemId}-${revision}`,
      revision: `rev-${revision}`,
      revisionAt: now,
      restriction: { teamIds: ["team-a"] },
      entries: bodies.map((body) => ({ classification: "reported_fact" as const, body })),
      now,
    });
    expect(outcome.status).toBe("stored");
  };
  const journal: string[] = [];
  const dream = (helper: FakeContextDreamHelper, now: number, enabled = true) =>
    dreamProjectContexts(db, access, {
      enabled,
      helper,
      now,
      journal: (line) => journal.push(line),
    });
  const topics = (now: number) =>
    listContextSummaries(db, {
      namespace,
      now,
      topics: true,
      visibility: {
        userId: alice.userId,
        teamIds: ["team-a"],
        repositories: [],
        channelIds: [],
        audience: "project_members",
        audienceLineage: "project_members@1",
      },
    });
  const index = async (now: number) => {
    const service = createProjectSessionContext({ db, access, memoryIndex: true, now: () => now });
    const prepared = await service.prepare({
      consumerKey: `work_item:${itemId}`,
      organizationId: workspaceId,
      projectId,
      requesterId: alice.userId,
      instructions: "",
      request: "Add an export of invoices",
    });
    return { text: prepared.text, service };
  };
  return {
    namespace,
    alice,
    access,
    remember,
    dream,
    journal,
    topics,
    index,
    projectId,
    workspaceId,
  };
}

const FACTS = [
  "The invoice exporter writes one column per tax rate.",
  "The invoice exporter writes one column per tax rate, rounded per line.",
  "Exports are generated nightly at 02:00 UTC.",
  "Finance imports the export into their ledger by hand.",
  "Exports older than 90 days are deleted.",
];

const taxIds = (entries: FakeDreamEntry[]) =>
  entries.filter((entry) => entry.body.includes("tax rate")).map((entry) => entry.id);

const taxTopic = (entries: FakeDreamEntry[]) => ({
  topics: [
    {
      title: "Tax columns",
      body: "One column per tax rate, rounded per line.",
      recordIds: taxIds(entries),
    },
  ],
});

test("with dream off nothing runs", async () => {
  const f = await fixture();
  await f.remember(FACTS, T0);
  const helper = createFakeContextDreamHelper(taxTopic);
  expect(await f.dream(helper, T0 + DAY, false)).toBe(0);
  expect(helper.calls).toHaveLength(0);
  expect(await f.topics(T0 + DAY)).toHaveLength(0);
});

test("five new records give one dream that stores topics with lineage, listed first in the index", async () => {
  const f = await fixture();
  await f.remember(FACTS, T0);
  let sent: FakeDreamEntry[] = [];
  const helper = createFakeContextDreamHelper((entries) => {
    sent = entries;
    return taxTopic(entries);
  });
  expect(await f.dream(helper, T0 + HOUR)).toBe(1);
  expect(helper.calls[0]!.prompt.startsWith(CONTEXT_DREAM_PROMPT)).toBe(true);
  expect(
    sent.every((entry) => entry.id && entry.classification && entry.source && entry.body),
  ).toBe(true);
  const stored = await f.topics(T0 + HOUR);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.title).toBe("Tax columns");
  expect(stored[0]!.valid).toBe(true);
  const lineage = await contextSummaryLineage(db, stored[0]!.id, 10);
  expect(lineage.map((entry) => entry.recordId).sort()).toEqual(taxIds(sent).sort());

  expect(await f.dream(helper, T0 + 2 * HOUR)).toBe(0);
  await f.remember(
    FACTS.slice(0, 4).map((fact) => `${fact} Confirmed.`),
    T0 + 2 * HOUR,
  );
  expect(await f.dream(helper, T0 + HOUR + DAY)).toBe(0);
  await f.remember(["Exports carry the invoice currency."], T0 + 3 * HOUR);
  expect(await f.dream(helper, T0 + 2 * HOUR)).toBe(0);
  expect(await f.dream(helper, T0 + HOUR + DAY)).toBe(1);
  expect(helper.calls).toHaveLength(2);

  const [topic] = await f.topics(T0 + DAY + HOUR);
  const { text, service } = await f.index(T0 + DAY + HOUR);
  const lines = text.split("\n");
  expect(lines[0]).toBe(MEMORY_INDEX_HEADER);
  expect(lines[1]).toBe(`- Topic: Tax columns (id ${topic!.id})`);
  for (const id of taxIds(sent)) expect(text).not.toContain(`id ${id})`);
  expect(lines.slice(2).some((line) => line.startsWith("- [reported_fact] "))).toBe(true);
  const recalled = await service.recall!({
    organizationId: f.workspaceId,
    projectId: f.projectId,
    requesterId: f.alice.userId,
    request: { id: topic!.id },
    now: T0 + DAY + HOUR,
  });
  expect(JSON.parse(recalled)).toEqual({
    id: topic!.id,
    topic: "Tax columns",
    body: "One column per tax rate, rounded per line.",
  });
});

test("forgetting a covered record clears its topic", async () => {
  const f = await fixture();
  await f.remember(FACTS, T0);
  let covered: string[] = [];
  const helper = createFakeContextDreamHelper((entries) => {
    covered = taxIds(entries);
    return taxTopic(entries);
  });
  expect(await f.dream(helper, T0 + HOUR)).toBe(1);
  expect(await f.topics(T0 + HOUR)).toHaveLength(1);
  const outcome = await forgetContextRecord(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    recordId: covered[0]!,
    now: T0 + 2 * HOUR,
  });
  expect(outcome.status).toBe("forgotten");
  expect(await f.topics(T0 + 2 * HOUR)).toEqual([]);
  expect((await f.index(T0 + 2 * HOUR)).text).not.toContain("- Topic:");
});

test("a topic citing an unknown record id is dropped", async () => {
  const f = await fixture();
  await f.remember(FACTS, T0);
  const helper = createFakeContextDreamHelper((entries) => ({
    topics: [
      {
        title: "Invented",
        body: "Cites a record nobody sent.",
        recordIds: [entries[0]!.id, "01UNKNOWN"],
      },
      ...taxTopic(entries).topics,
    ],
  }));
  expect(await f.dream(helper, T0 + HOUR)).toBe(1);
  expect((await f.topics(T0 + HOUR)).map((topic) => topic.title)).toEqual(["Tax columns"]);
});

test("a helper failure leaves selection unchanged and retries after 24 hours", async () => {
  const f = await fixture();
  await f.remember(FACTS, T0);
  const before = (await f.index(T0 + HOUR)).text;
  const helper = createFakeContextDreamHelper(new Error("runner offline"));
  expect(await f.dream(helper, T0 + HOUR)).toBe(0);
  expect(helper.calls).toHaveLength(1);
  expect(f.journal).toHaveLength(1);
  expect(f.journal[0]).toContain("failed");
  expect(await f.topics(T0 + HOUR)).toEqual([]);
  expect((await f.index(T0 + HOUR)).text).toBe(before);
  helper.reply = taxTopic;
  await f.remember(
    FACTS.map((fact) => `${fact} Retry.`),
    T0 + 2 * HOUR,
  );
  expect(await f.dream(helper, T0 + 2 * HOUR)).toBe(0);
  expect(helper.calls).toHaveLength(1);
  expect(await f.dream(helper, T0 + HOUR + DAY)).toBe(1);
  expect(helper.calls).toHaveLength(2);
});

test("an existing topic reaches the index and recall only while its requester can see it and its lineage is current", async () => {
  const f = await fixture();
  await f.remember(FACTS, T0);
  let covered: string[] = [];
  const helper = createFakeContextDreamHelper((entries) => {
    covered = taxIds(entries);
    return taxTopic(entries);
  });
  expect(await f.dream(helper, T0 + HOUR)).toBe(1);
  const [topic] = await f.topics(T0 + HOUR);
  const at = T0 + 2 * HOUR;
  const recall = async () =>
    (await f.index(at)).service.recall!({
      organizationId: f.workspaceId,
      projectId: f.projectId,
      requesterId: f.alice.userId,
      request: { id: topic!.id },
      now: at,
    });
  expect((await f.index(at)).text).toContain(`- Topic: Tax columns (id ${topic!.id})`);
  expect(await recall()).toContain("Tax columns");

  f.access.grant(f.alice, { teamIds: ["team-b"], repositories: [], channelIds: [] });
  expect((await f.index(at)).text).not.toContain("Tax columns");
  expect(await recall()).not.toContain("Tax columns");
  f.access.grant(f.alice, { teamIds: ["team-a"], repositories: [], channelIds: [] });

  await seed(db, (q) =>
    q.orm
      .update(q.t.contextRecord)
      .set({ restriction: { teamIds: ["team-a"], userId: "someone-else" } })
      .where(eq(q.t.contextRecord.id, covered[0]!)),
  );
  expect((await f.topics(at)).map((row) => [row.status, row.valid])).toEqual([["current", false]]);
  expect((await f.index(at)).text).not.toContain("Tax columns");
  expect(await recall()).not.toContain("Tax columns");
});
