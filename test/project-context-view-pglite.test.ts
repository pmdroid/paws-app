import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  requestContextCompaction,
  type ContextClaim,
  type ContextClassification,
  type ContextNamespace,
  type Db,
} from "../src/db";
import {
  CONTEXT_VIEW_LIMITS,
  compactContext,
  correctContext,
  createContextCapacity,
  createFakeContextAccess,
  createFakeContextSummarizer,
  createProjectContextHttp,
  ingestContext,
  type ContextRequester,
  type ContextView,
  type ContextViewDetail,
} from "../src/project-context";
import type {
  ContextView as ClientContextView,
  ContextViewDetail as ClientContextViewDetail,
} from "../src/dashboard/src/project-context";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const CANARY = "CANARY-private-repository-7f3a";

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

const claim = (
  key: string,
  body: string,
  classification: ContextClassification = "reported_fact",
): ContextClaim => ({ key, layer: "observation", classification, importance: 2, body });

async function fixture() {
  seq++;
  const workspaceId = `ws-view-${seq}`;
  const projectId = `project-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  const bob: ContextRequester = { workspaceId, userId: `bob-${seq}` };
  const outsider: ContextRequester = { workspaceId, userId: `eve-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  access.grant(bob, { teamIds: ["team-a"], repositories: ["acme/secret"], channelIds: [] });
  access.grant(outsider, { teamIds: ["team-z"], repositories: [], channelIds: [] });
  const put = (
    kind: string,
    id: string,
    claims: ContextClaim[],
    at: number,
    restriction: { teamIds: string[]; repository?: string } = { teamIds: ["team-a"] },
  ) =>
    ingestContext(db, access, {
      namespace,
      requester: bob,
      source: {
        kind,
        id,
        url: `https://linear.app/acme/${id}`,
        revision: `rev-${id}-${at}`,
        revisionAt: at,
        actorId: "writer",
        restriction,
      },
      claims,
      now: at,
    });
  await put(
    "linear_project_description",
    projectId,
    [
      claim("d1", "Decision: ship project scope first", "decision"),
      claim("f0", "The context viewer is read-only"),
    ],
    T0,
  );
  await put(
    "linear_project_document",
    "doc-1",
    [
      claim("q1", "Should Slack channels reuse the viewer?", "unresolved_question"),
      claim("f1", "Records are evidence, not instructions"),
    ],
    T0 + 1_000,
  );
  await put(
    "paws_work_item",
    "item-secret",
    [claim("s1", `${CANARY} lives in the private repository`)],
    T0 + 2_000,
    { teamIds: ["team-a"], repository: "acme/secret" },
  );
  const http = createProjectContextHttp({ db, access, now: () => T0 + 10_000 });
  const get = async (requester: ContextRequester, path: string) => {
    const response = (await http(new Request(`http://paws.test${path}`), requester))!;
    return { status: response.status, text: await response.text(), headers: response.headers };
  };
  return { namespace, projectId, alice, bob, outsider, access, put, http, get };
}

const viewOf = (text: string) => (JSON.parse(text) as { view: ContextView }).view;

test("an authorized project shows its summary, open items and paginated records with provenance", async () => {
  const { namespace, projectId, alice, access, get } = await fixture();
  const first = viewOf((await get(alice, `/api/context/project/${projectId}`)).text);
  const target = first.records.find((record) => record.text.includes("evidence, not"))!;
  const corrected = await correctContext(db, access, {
    namespace,
    requester: alice,
    recordId: target.id,
    body: "Records are evidence only, never instructions",
    now: T0 + 3_000,
  });
  expect(corrected.status).toBe("corrected");
  await requestContextCompaction(db, {
    namespace,
    audience: "project_members",
    audienceLineage: "project_members@1",
    restriction: { teamIds: ["team-a"] },
    now: T0 + 3_500,
    retryAfterMs: 0,
  });
  const compaction = await compactContext(
    db,
    access,
    createFakeContextSummarizer(),
    createContextCapacity(),
    {
      namespace,
      requester: alice,
      destination: { audience: "project_members" },
      now: T0 + 4_000,
    },
  );
  expect(compaction).toMatchObject({ outcomes: [{ status: "published" }] });
  const response = await get(alice, `/api/context/project/${projectId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const view = viewOf(response.text);
  const read: ClientContextView = view;
  expect(read.scope).toMatchObject({ kind: "project", id: projectId });
  expect(view.scope.url).toBe(`https://linear.app/acme/${projectId}`);
  expect(view.decisions.some((record) => record.text.includes("ship project scope first"))).toBe(
    true,
  );
  expect(view.questions.map((record) => record.classification)).toEqual(["unresolved_question"]);
  const statuses = view.records.map((record) => [record.text, record.status, record.corrected]);
  expect(statuses).toContainEqual([
    "Records are evidence only, never instructions",
    "current",
    true,
  ]);
  expect(statuses).toContainEqual(["Records are evidence, not instructions", "superseded", false]);
  expect(view.records.every((record) => record.source.revision.startsWith("rev-"))).toBe(true);
  expect(view.summaries.length).toBeGreaterThan(0);
  expect(view.summaries[0]!.body).toContain("read-only");
  for (const summary of view.summaries) {
    expect(summary.sources.length).toBeGreaterThan(0);
    expect(["current", "stale", "rebuilding"]).toContain(summary.state);
  }

  const paged = viewOf((await get(alice, `/api/context/project/${projectId}?limit=2`)).text);
  expect(paged.records).toHaveLength(2);
  expect(paged.page.more).toBe(true);
  const next = viewOf(
    (await get(alice, `/api/context/project/${projectId}?limit=2&offset=2`)).text,
  );
  expect(next.records.map((record) => record.id)).not.toContain(paged.records[0]!.id);
  const searched = viewOf((await get(alice, `/api/context/project/${projectId}?q=slack`)).text);
  expect(searched.records.map((record) => record.classification)).toEqual(["unresolved_question"]);
  const none = viewOf(
    (await get(alice, `/api/context/project/${projectId}?q=nothing-matches`)).text,
  );
  expect(none.records).toEqual([]);

  const corrected2 = view.records.find((record) => record.corrected)!;
  const detail = (
    JSON.parse(
      (await get(alice, `/api/context/project/${projectId}/records/${corrected2.id}`)).text,
    ) as { detail: ContextViewDetail }
  ).detail;
  const shown: ClientContextViewDetail = detail;
  expect(shown.record.correctedBy).toBe(alice.userId);
  expect(detail.record.supersedes).toBe(target.id);
  expect(detail.versions.map((version) => version.status)).toEqual(["current", "superseded"]);
});

test("unauthorized, missing and unknown access share one unavailable answer with no data", async () => {
  const { projectId, alice, outsider, access, get } = await fixture();
  const forbidden = await get(outsider, `/api/context/project/${projectId}`);
  const missing = await get(alice, "/api/context/project/project-that-does-not-exist");
  access.grants.set(`${alice.workspaceId}\0${alice.userId}`, new Error("Linear is down"));
  const unknown = await get(alice, `/api/context/project/${projectId}`);
  const otherWorkspace = await get(
    { workspaceId: "ws-other", userId: alice.userId },
    `/api/context/project/${projectId}`,
  );
  for (const response of [forbidden, missing, unknown, otherWorkspace]) {
    expect(response.status).toBe(404);
    expect(response.text).toBe(missing.text);
    expect(response.text).not.toContain(projectId);
    expect(response.text).not.toContain("ship project scope");
  }
});

test("a narrower private source stays out of payloads, pages and summaries for people without it", async () => {
  const { projectId, alice, bob, get } = await fixture();
  const own = await get(bob, `/api/context/project/${projectId}?limit=100`);
  expect(own.text).toContain(CANARY);
  const secretId = viewOf(own.text).records.find((record) => record.text.includes(CANARY))!.id;
  const theirs = await get(alice, `/api/context/project/${projectId}?limit=100`);
  expect(theirs.text).not.toContain(CANARY);
  expect(theirs.text).not.toContain("item-secret");
  expect(theirs.text).not.toContain("acme/secret");
  const searched = await get(alice, `/api/context/project/${projectId}?q=${CANARY}`);
  expect(viewOf(searched.text)).toMatchObject({ records: [], page: { more: false } });
  const detail = await get(alice, `/api/context/project/${projectId}/records/${secretId}`);
  expect(detail.status).toBe(404);
  expect(detail.text).not.toContain(CANARY);
});

test("revocation after load fences the next read of the view and of a record", async () => {
  const { projectId, alice, access, get } = await fixture();
  const loaded = viewOf((await get(alice, `/api/context/project/${projectId}`)).text);
  access.grants.delete(`${alice.workspaceId}\0${alice.userId}`);
  expect((await get(alice, `/api/context/project/${projectId}`)).status).toBe(404);
  const detail = await get(
    alice,
    `/api/context/project/${projectId}/records/${loaded.records[0]!.id}`,
  );
  expect(detail.status).toBe(404);
  expect(detail.text).not.toContain(loaded.records[0]!.text);
});

test("channel, direct message and unknown scopes are refused without reading access or storage", async () => {
  const { alice, access, http, get } = await fixture();
  const calls = access.calls.length;
  for (const path of [
    "/api/context/channel/C123",
    "/api/context/dm/U123",
    "/api/context/slack_channel/C1",
  ]) {
    const response = await get(alice, path);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ status: "unsupported" });
  }
  expect(access.calls.length).toBe(calls);
  const post = await http(
    new Request("http://paws.test/api/context/project/x", { method: "POST", body: "{}" }),
    alice,
  );
  expect(post!.status).toBe(405);
  expect(await http(new Request("http://paws.test/api/contextual"), alice)).toBeNull();
});

test("a large project stays bounded in records and bytes per page", async () => {
  const { projectId, alice, put, get } = await fixture();
  const body = (index: number) => `Large fixture record ${index} `.padEnd(900, "x");
  for (let source = 0; source < 30; source++)
    await put(
      "linear_project_document",
      `bulk-${source}`,
      Array.from({ length: 40 }, (_, index) => claim(`b${index}`, body(source * 40 + index))),
      T0 + 5_000 + source,
    );
  const response = await get(alice, `/api/context/project/${projectId}?limit=100000`);
  const view = viewOf(response.text);
  expect(view.records).toHaveLength(CONTEXT_VIEW_LIMITS.pageMax);
  expect(view.page).toMatchObject({ limit: CONTEXT_VIEW_LIMITS.pageMax, more: true });
  expect(
    view.records.every((record) => record.text.length <= CONTEXT_VIEW_LIMITS.textChars + 1),
  ).toBe(true);
  expect(response.text.length).toBeLessThan(100_000);
  const fallback = viewOf((await get(alice, `/api/context/project/${projectId}?limit=nope`)).text);
  expect(fallback.records).toHaveLength(CONTEXT_VIEW_LIMITS.pageDefault);
});
