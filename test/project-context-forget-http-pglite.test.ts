import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { saveWorkItemLinearProject, type ContextNamespace, type Db } from "../src/db";
import {
  createFakeContextAccess,
  createProjectContextHttp,
  ingestContext,
  recordWorkItemContext,
  selectContext,
  type ContextRequester,
  type ContextView,
} from "../src/project-context";
import { tempStore } from "./pglite";
import { insertWorkItem, seed } from "./pglite-fixtures";

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

async function workItem(id: string, identifier: string, organizationId: string, project: string) {
  await insertWorkItem(db, id);
  await saveWorkItemLinearProject(db, id, { id: project, name: "Exports" });
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: `session-${id}`,
        organizationId,
        createdAt: T0,
      }),
    (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ sessionKey: `session-${id}`, linearIdentifier: identifier })
        .where(eq(q.t.workItem.id, id)),
  );
}

async function fixture(workspaceId = `org-forget-http-${seq + 1}`) {
  seq++;
  const projectId = `project-forget-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const admin: ContextRequester = { workspaceId, userId: `admin-${seq}` };
  const member: ContextRequester = { workspaceId, userId: `member-${seq}` };
  const access = createFakeContextAccess();
  for (const requester of [admin, member])
    access.grant(requester, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: [] });
  const source = (kind: string, id: string, url: string | null, revision: string) => ({
    kind,
    id,
    url,
    revision,
    revisionAt: T0,
    actorId: "writer",
    restriction: { teamIds: ["team-a"] },
  });
  await ingestContext(db, access, {
    namespace,
    requester: admin,
    source: source("linear_project_description", projectId, null, "rev-description"),
    claims: [
      {
        key: "d1",
        layer: "observation",
        classification: "reported_fact",
        importance: 1,
        body: "Exports are nightly CSV files.",
      },
    ],
    now: T0,
  });
  await ingestContext(db, access, {
    namespace,
    requester: admin,
    source: source("linear_project_document", "doc-1", "https://linear.app/acme/doc-1", "rev-doc"),
    claims: [
      {
        key: "doc1",
        layer: "observation",
        classification: "reported_fact",
        importance: 1,
        body: "DOCUMENT-FACT exports keep a header row.",
      },
    ],
    now: T0,
  });
  const itemId = `item-forget-${seq}`;
  await workItem(itemId, `PAS-${900 + seq}`, workspaceId, projectId);
  await recordWorkItemContext(db, access, {
    namespace,
    requester: admin,
    workItemId: itemId,
    revision: `remember-${T0}`,
    revisionAt: T0,
    restriction: { teamIds: ["team-a"] },
    entries: [
      { classification: "reported_fact", body: "CANARY-FORGET-HTTP exports retry three times." },
      { classification: "reported_fact", body: "SIBLING-HTTP exports run nightly." },
    ],
    now: T0,
  });
  const roles = new Map([
    [admin.userId, true],
    [member.userId, false],
  ]);
  const http = createProjectContextHttp({ db, access, now: () => T0 + MINUTE });
  const call = async (requester: ContextRequester, method: string, path: string) => {
    const response = (await http(
      new Request(`http://paws.test${path}`, { method }),
      requester,
      async () => roles.get(requester.userId) === true,
    ))!;
    return { status: response.status, text: await response.text() };
  };
  const view = async (requester: ContextRequester) =>
    (
      JSON.parse(
        (await call(requester, "GET", `/api/context/project/${projectId}?limit=100`)).text,
      ) as {
        view: ContextView;
      }
    ).view;
  const forgetPath = (id: string, project = projectId) =>
    `/api/context/project/${project}/records/${id}/forget`;
  return { namespace, projectId, admin, member, access, roles, itemId, call, view, forgetPath };
}

async function packText(f: Awaited<ReturnType<typeof fixture>>, now: number) {
  const selection = await selectContext(db, f.access, {
    namespace: f.namespace,
    requester: f.admin,
    destination: { audience: "project_members" },
    instructions: "You are working on a Paws task.",
    request: "Fix the export retry behaviour",
    toolsTokens: 300,
    repository: "acme/app",
    recent: [],
    model: { contextTokens: 100_000 },
    now,
  });
  if (selection.status !== "ok") throw new Error(`selection ${selection.status}`);
  return selection.pack;
}

test("records carry their source labels and only admins see work item rows as forgettable", async () => {
  const f = await fixture();
  const shown = await f.view(f.admin);
  const doc = shown.records.find((record) => record.text.includes("DOCUMENT-FACT"))!;
  expect(doc.source).toMatchObject({
    label: "Linear document",
    url: "https://linear.app/acme/doc-1",
  });
  expect(doc.forgettable).toBe(false);
  const memory = shown.records.find((record) => record.text.includes("CANARY-FORGET-HTTP"))!;
  expect(memory.source.label).toBe(`Agent on PAS-${900 + seq}`);
  expect(memory.forgettable).toBe(true);
  const description = shown.records.find((record) => record.text.includes("nightly CSV"))!;
  expect(description.forgettable).toBe(false);
  const forMember = await f.view(f.member);
  expect(forMember.records.every((record) => !record.forgettable)).toBe(true);
  expect(forMember.records.find((record) => record.id === memory.id)!.source.label).toBe(
    `Agent on PAS-${900 + seq}`,
  );
});

test("a work item from another workspace or project never lends its identifier", async () => {
  const f = await fixture();
  const strangerId = `item-stranger-${seq}`;
  await workItem(strangerId, "OTHER-1", "org-somebody-else", f.projectId);
  const elsewhereId = `item-elsewhere-${seq}`;
  await workItem(elsewhereId, "OTHER-2", f.namespace.workspaceId, "project-elsewhere");
  for (const workItemId of [strangerId, elsewhereId])
    await recordWorkItemContext(db, f.access, {
      namespace: f.namespace,
      requester: f.admin,
      workItemId,
      revision: `remember-${T0}`,
      revisionAt: T0,
      restriction: { teamIds: ["team-a"] },
      entries: [{ classification: "reported_fact", body: `FOREIGN ${workItemId} entry.` }],
      now: T0,
    });
  const text = JSON.stringify(await f.view(f.admin));
  expect(text).not.toContain("OTHER-1");
  expect(text).not.toContain("OTHER-2");
  const shown = await f.view(f.admin);
  expect(shown.records.filter((row) => row.text.startsWith("FOREIGN"))).toHaveLength(2);
  for (const entry of shown.records.filter((row) => row.text.startsWith("FOREIGN")))
    expect(entry.source.label).toBe("Work item memory");
});

test("an admin forgets one entry and the next selection lacks it", async () => {
  const f = await fixture();
  expect(await packText(f, T0 + MINUTE)).toContain("CANARY-FORGET-HTTP");
  const target = (await f.view(f.admin)).records.find((record) =>
    record.text.includes("CANARY-FORGET-HTTP"),
  )!;
  const response = await f.call(f.admin, "POST", f.forgetPath(target.id));
  expect(response.status).toBe(200);
  expect(JSON.parse(response.text)).toEqual({ status: "forgotten", forgotten: { entries: 1 } });
  const pack = await packText(f, T0 + 2 * MINUTE);
  expect(pack).not.toContain("CANARY-FORGET-HTTP");
  expect(pack).toContain("SIBLING-HTTP");
  const after = await f.view(f.admin);
  expect(after.records.some((record) => record.text.includes("CANARY-FORGET-HTTP"))).toBe(false);
  const again = await f.call(f.admin, "POST", f.forgetPath(target.id));
  expect(again.status).toBe(404);
});

test("a member gets 403 and forgets nothing", async () => {
  const f = await fixture();
  const target = (await f.view(f.member)).records.find((record) =>
    record.text.includes("CANARY-FORGET-HTTP"),
  )!;
  const response = await f.call(f.member, "POST", f.forgetPath(target.id));
  expect(response.status).toBe(403);
  expect(await packText(f, T0 + 2 * MINUTE)).toContain("CANARY-FORGET-HTTP");
});

test("a forged record id from another project or workspace gets the same 404 and nothing changes", async () => {
  const f = await fixture();
  const sibling = await fixture(f.namespace.workspaceId);
  const other = await fixture();
  const canary = async (g: typeof f) =>
    (await g.view(g.admin)).records.find((record) => record.text.includes("CANARY-FORGET-HTTP"))!;
  const siblings = await canary(sibling);
  const theirs = await canary(other);
  const doc = (await f.view(f.admin)).records.find((record) =>
    record.text.includes("DOCUMENT-FACT"),
  )!;
  const unknown = await f.call(f.admin, "POST", f.forgetPath("01NOTAREALRECORD0000000000"));
  const crossProject = await f.call(f.admin, "POST", f.forgetPath(siblings.id));
  const crossWorkspace = await f.call(f.admin, "POST", f.forgetPath(theirs.id));
  const theirProject = await f.call(f.admin, "POST", f.forgetPath(theirs.id, other.projectId));
  const linearDocument = await f.call(f.admin, "POST", f.forgetPath(doc.id));
  for (const response of [crossProject, crossWorkspace, theirProject, linearDocument]) {
    expect(response.status).toBe(404);
    expect(response.text).toBe(unknown.text);
    expect(response.text).not.toContain("CANARY");
  }
  expect(await packText(sibling, T0 + 2 * MINUTE)).toContain("CANARY-FORGET-HTTP");
  expect(await packText(other, T0 + 2 * MINUTE)).toContain("CANARY-FORGET-HTTP");
  expect(JSON.stringify(await f.view(f.admin))).toContain("DOCUMENT-FACT");
});

test("access or the admin role revoked between render and submit refuses the forget", async () => {
  const f = await fixture();
  const target = (await f.view(f.admin)).records.find((record) =>
    record.text.includes("CANARY-FORGET-HTTP"),
  )!;
  expect(target.forgettable).toBe(true);
  f.roles.set(f.admin.userId, false);
  expect((await f.call(f.admin, "POST", f.forgetPath(target.id))).status).toBe(403);
  f.roles.set(f.admin.userId, true);
  f.access.grants.delete(`${f.admin.workspaceId}\0${f.admin.userId}`);
  const revoked = await f.call(f.admin, "POST", f.forgetPath(target.id));
  expect(revoked.status).toBe(404);
  expect(revoked.text).not.toContain("CANARY");
  f.access.grant(f.admin, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: [] });
  expect(await packText(f, T0 + 2 * MINUTE)).toContain("CANARY-FORGET-HTTP");
});

test("forget answers only POST, and the read routes stay GET only", async () => {
  const f = await fixture();
  const target = (await f.view(f.admin)).records[0]!;
  expect((await f.call(f.admin, "GET", f.forgetPath(target.id))).status).toBe(405);
  expect(
    (await f.call(f.admin, "POST", `/api/context/project/${f.projectId}/records/${target.id}`))
      .status,
  ).toBe(405);
});
