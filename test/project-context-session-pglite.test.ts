import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  getContextSession,
  type ContextNamespace,
  type ContextRestriction,
  type Db,
} from "../src/db";
import {
  CONTEXT_PACK_HEADER,
  CONTEXT_SESSION_NOTICE,
  checkContextDelivery,
  correctContext,
  createFakeContextAccess,
  createLinearContextAccess,
  inspectSessionContext,
  prepareSessionContext,
  recordWorkItemContext,
  type ContextBudgetSettings,
  type ContextConsumerRequest,
  type ContextRequester,
  type FakeContextAccess,
  type SessionContext,
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
  hardCapTokens: 6_000,
  responseTokens: 1_000,
  memoryTokens: 900,
  recentTokens: 300,
  softThresholdTokens: 600,
  summaryOutputTokens: 200,
  summaryInputTokens: 2_000,
  candidates: 120,
  references: 6,
  summaryTimeoutMs: 1_000,
  compactionRetryMs: 60_000,
};

const project = { audience: "project_members" } as const;

const DECISION = "Exports stay CSV-only for the first release";
const REASON = "finance imports CSV and nothing else";
const QUESTION = "Should exports include archived invoices";

function fixture() {
  seq++;
  const workspaceId = `org-${seq}`;
  const projectId = `project-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  return { workspaceId, projectId, namespace, alice, access };
}

async function sessionA(
  access: FakeContextAccess,
  namespace: ContextNamespace,
  requester: ContextRequester,
  options: { workItemId?: string; restriction?: ContextRestriction; at?: number } = {},
) {
  const at = options.at ?? T0;
  const outcome = await recordWorkItemContext(db, access, {
    namespace,
    requester,
    workItemId: options.workItemId ?? `item-a-${seq}`,
    revision: `rev-${at}`,
    revisionAt: at,
    restriction: options.restriction ?? { teamIds: ["team-a"] },
    entries: [
      { classification: "decision", body: DECISION, reason: REASON },
      { classification: "unresolved_question", body: QUESTION },
    ],
    now: at,
  });
  expect(outcome.status).toBe("stored");
  return outcome;
}

function consumer(
  namespace: ContextNamespace,
  requester: ContextRequester,
  overrides: Partial<ContextConsumerRequest> = {},
): ContextConsumerRequest {
  return {
    consumerKey: `work_item:b-${seq}`,
    namespace,
    requester,
    destination: project,
    instructions: "Implement the issue.",
    request: "Add an export of invoices",
    toolsTokens: 200,
    recent: [{ text: "The person asked for a CSV export.", at: T0 }],
    model: { contextTokens: 100_000 },
    settings: SMALL,
    now: T0 + MINUTE,
    ...overrides,
  };
}

function injected(result: SessionContext) {
  if (result.status !== "injected" || !result.manifest)
    throw new Error(`not injected: ${JSON.stringify(result)}`);
  return { ...result, manifest: result.manifest };
}

test("a fresh session receives the decision, its reason and the open question with provenance", async () => {
  const { namespace, alice, access } = fixture();
  await sessionA(access, namespace, alice);
  const b = injected(await prepareSessionContext(db, access, consumer(namespace, alice)));
  expect(b.text.startsWith(CONTEXT_PACK_HEADER)).toBe(true);
  expect(b.text).toContain(DECISION);
  expect(b.text).toContain(REASON);
  expect(b.text).toContain(QUESTION);
  expect(b.text).toContain(`source: paws_work_item item-a-${seq}@rev-${T0}`);
  expect(b.text).toContain(CONTEXT_SESSION_NOTICE);
  expect(b.manifest.tokens.total).toBeLessThanOrEqual(b.manifest.tokens.hardCap);
  expect(b.manifest.sources.map((source) => source.classification).sort()).toEqual([
    "decision",
    "unresolved_question",
  ]);
  const stored = await getContextSession(db, `work_item:b-${seq}`);
  expect(stored).toMatchObject({ version: 1, status: "injected", requesterId: alice.userId });
  expect(
    await checkContextDelivery(db, access, {
      consumerKey: `work_item:b-${seq}`,
      requester: alice,
      destination: project,
      version: 1,
      now: T0 + MINUTE,
    }),
  ).toEqual({ status: "current" });
});

test("a correction supersedes the stale fact and fences the earlier pack", async () => {
  const { namespace, alice, access } = fixture();
  await sessionA(access, namespace, alice);
  const before = injected(await prepareSessionContext(db, access, consumer(namespace, alice)));
  const decision = before.manifest.sources.find((source) => source.classification === "decision")!;
  const corrected = await correctContext(db, access, {
    namespace,
    requester: alice,
    recordId: decision.recordId,
    body: "Exports offer CSV and XLSX from the first release.",
    now: T0 + 2 * MINUTE,
  });
  expect(corrected.status).toBe("corrected");
  expect(
    await checkContextDelivery(db, access, {
      consumerKey: `work_item:b-${seq}`,
      requester: alice,
      destination: project,
      version: before.version,
      now: T0 + 2 * MINUTE,
    }),
  ).toEqual({ status: "stale", reason: "invalidated" });
  const after = injected(
    await prepareSessionContext(db, access, consumer(namespace, alice, { now: T0 + 3 * MINUTE })),
  );
  expect(after.text).toContain("CSV and XLSX");
  expect(after.text).not.toContain(DECISION);
  expect(after.text).toContain("decision, corrected");
  expect(
    await checkContextDelivery(db, access, {
      consumerKey: `work_item:b-${seq}`,
      requester: alice,
      destination: project,
      version: before.version,
      now: T0 + 3 * MINUTE,
    }),
  ).toEqual({ status: "stale", reason: "superseded" });
});

test("other projects, workspaces, narrower sources and Slack-shaped consumers never see the canaries", async () => {
  const { workspaceId, namespace, alice, access } = fixture();
  const canary = `CANARY-${seq}`;
  const privateSource = `private-item-${seq}`;
  await sessionA(access, namespace, alice);
  const bob: ContextRequester = { workspaceId, userId: `bob-${seq}` };
  access.grant(bob, { teamIds: ["team-a"], repositories: [], channelIds: ["C1"] });
  const narrow = await recordWorkItemContext(db, access, {
    namespace,
    requester: bob,
    workItemId: privateSource,
    url: `https://paws.example/private/${privateSource}`,
    revision: "r1",
    revisionAt: T0,
    restriction: { teamIds: ["team-a"], userId: bob.userId },
    entries: [{ classification: "decision", body: `${canary} private decision` }],
    now: T0,
  });
  expect(narrow.status).toBe("stored");
  const otherProject: ContextNamespace = { ...namespace, scopeId: `other-${seq}` };
  await recordWorkItemContext(db, access, {
    namespace: otherProject,
    requester: alice,
    workItemId: `other-item-${seq}`,
    revision: "r1",
    revisionAt: T0,
    restriction: { teamIds: ["team-a"] },
    entries: [{ classification: "decision", body: `${canary} other project` }],
    now: T0,
  });
  const otherWorkspace: ContextNamespace = { ...namespace, workspaceId: `${workspaceId}-b` };
  const mallory: ContextRequester = { workspaceId: otherWorkspace.workspaceId, userId: "mallory" };
  access.grant(mallory, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  await recordWorkItemContext(db, access, {
    namespace: otherWorkspace,
    requester: mallory,
    workItemId: `ws-item-${seq}`,
    revision: "r1",
    revisionAt: T0,
    restriction: { teamIds: ["team-a"] },
    entries: [{ classification: "decision", body: `${canary} other workspace` }],
    now: T0,
  });

  const forAlice = injected(await prepareSessionContext(db, access, consumer(namespace, alice)));
  const aliceView =
    JSON.stringify(forAlice) + JSON.stringify(await getContextSession(db, `work_item:b-${seq}`));
  expect(aliceView).not.toContain(canary);
  expect(aliceView).not.toContain(privateSource);
  expect(forAlice.manifest.counts.candidates).toBe(2);

  const crossWorkspace = await prepareSessionContext(
    db,
    access,
    consumer(otherWorkspace, alice, { consumerKey: `cross-${seq}` }),
  );
  expect(crossWorkspace.status).toBe("withheld");
  expect(JSON.stringify(crossWorkspace)).not.toContain(canary);

  for (const destination of [
    { audience: "private_user", userId: alice.userId },
    { audience: "channel_members", channelId: "C1" },
  ]) {
    const slack = await prepareSessionContext(
      db,
      access,
      consumer(namespace, bob, {
        consumerKey: `slack-${seq}-${destination.audience}`,
        destination,
      }),
    );
    expect(slack).toMatchObject({ status: "withheld", reason: "refused" });
    expect(JSON.stringify(slack)).not.toContain(DECISION);
  }
  const channel: ContextNamespace = { workspaceId, scopeKind: "slack_channel", scopeId: "C1" };
  const channelPack = await prepareSessionContext(
    db,
    access,
    consumer(channel, bob, {
      consumerKey: `slack-channel-${seq}`,
      destination: { audience: "channel_members", channelId: "C1" },
    }),
  );
  expect(channelPack).toMatchObject({ status: "withheld", reason: "empty", text: "" });
  const dm: ContextNamespace = { workspaceId, scopeKind: "user_private", scopeId: bob.userId };
  const dmPack = await prepareSessionContext(
    db,
    access,
    consumer(dm, bob, {
      consumerKey: `slack-dm-${seq}`,
      destination: { audience: "private_user", userId: bob.userId },
    }),
  );
  expect(dmPack).toMatchObject({ status: "withheld", reason: "empty" });

  expect(
    await inspectSessionContext(db, access, {
      consumerKey: `work_item:b-${seq}`,
      namespace: otherProject,
      requester: alice,
      destination: project,
      now: T0 + MINUTE,
    }),
  ).toBeNull();
  const carol: ContextRequester = { workspaceId, userId: `carol-${seq}` };
  access.grant(carol, { teamIds: ["team-b"], repositories: [], channelIds: [] });
  const carolView = await inspectSessionContext(db, access, {
    consumerKey: `work_item:b-${seq}`,
    namespace,
    requester: carol,
    destination: project,
    now: T0 + MINUTE,
  });
  expect(carolView?.records).toEqual([]);
  expect(JSON.stringify(carolView)).not.toContain(DECISION);
});

test("Linear membership decides access and an inactive or foreign member sees nothing", async () => {
  const members = new Map<string, { active: boolean; organizationId: string; teamIds: string[] }>([
    ["active", { active: true, organizationId: "org", teamIds: ["team-a"] }],
    ["gone", { active: false, organizationId: "org", teamIds: ["team-a"] }],
    ["foreign", { active: true, organizationId: "other", teamIds: ["team-a"] }],
  ]);
  const access = createLinearContextAccess({
    async member(organizationId, userId) {
      const found = members.get(userId);
      if (!found) throw new Error("unknown");
      return { userId, guest: false, admin: false, ...found, organizationId: found.organizationId };
    },
  });
  expect(await access.currentAccess({ workspaceId: "org", userId: "active" })).toEqual({
    userId: "active",
    teamIds: ["team-a"],
    repositories: [],
    channelIds: [],
  });
  expect(await access.currentAccess({ workspaceId: "org", userId: "gone" })).toBeNull();
  expect(await access.currentAccess({ workspaceId: "org", userId: "foreign" })).toBeNull();
});

test("concurrent prepares for one session are serialized and each stays deliverable", async () => {
  const { namespace, alice, access } = fixture();
  await sessionA(access, namespace, alice);
  const results = await Promise.all(
    [0, 1, 2].map(() => prepareSessionContext(db, access, consumer(namespace, alice))),
  );
  expect(results.map((result) => result.status)).toEqual(["injected", "injected", "injected"]);
  expect(results.map((result) => result.version).sort()).toEqual([1, 2, 3]);
  expect((await getContextSession(db, `work_item:b-${seq}`))?.version).toBe(3);
});

