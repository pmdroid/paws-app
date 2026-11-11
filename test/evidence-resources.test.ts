import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveVisualReviewMarks,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { createEvidenceStore, evidencePath } from "../src/evidence";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

const HEAD = "c".repeat(40);
const encode = (value: string) => [...new TextEncoder().encode(value)];
const WEBM = new Uint8Array([
  0x1a,
  0x45,
  0xdf,
  0xa3,
  0x9f,
  0x42,
  0x86,
  0x81,
  0x01,
  0x42,
  0x82,
  0x84,
  ...encode("webm"),
  0x42,
  0x87,
  0x81,
  0x04,
  ...encode("0123456789"),
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...encode("IHDR")]);
const MARK = new Uint8Array([...PNG, ...encode("marked")]);
const MARK_ID = "01HZZZZZZZZZZZZZZZZZZZMARK";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Evidence = { id: string; itemId: string; checkId: string; attempt: number };

async function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
  );
  await putWorkspaceUser(sqliteDb(db), {
    id: "member",
    linearUserId: "member",
    name: "member",
    email: "m@x.test",
  });
  let teamIds = ["team"];
  const member = async () =>
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds,
      now: Date.now(),
    });
  await member();
  for (const [session, team] of [
    ["session-mine", "team"],
    ["session-other", "other-team"],
  ])
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
        installation_observed_at, created_at) VALUES (?, 'org', 'fixture', 'app', ?, 1, 0)`,
      [session!, team!],
    );
  insertQueuedItem(db, { id: "PAS-1", sessionKey: "session-mine", now: Date.now() });
  insertQueuedItem(db, { id: "PAS-OLD", sessionKey: "session-mine" });
  db.run("UPDATE work_item SET state = 'merged' WHERE id = 'PAS-OLD'");
  insertQueuedItem(db, { id: "PAS-2", sessionKey: "session-other", now: Date.now() });

  const home = mkdtempSync(join(tmpdir(), "paws-evidence-resources-"));
  homes.push(home);
  const evidenceDir = join(home, "evidence");
  const store = createEvidenceStore({ db, root: evidenceDir });
  const save = (itemId: string, source: Uint8Array, displayName: string, attempt = 1) =>
    store.save({
      itemId,
      runId: `run-${itemId}`,
      checkId: "visual-proof",
      attempt,
      displayName,
      headCommit: HEAD,
      source: new Blob([source]),
    });
  const video = await save("PAS-1", WEBM, "flow.webm");
  const old = await save("PAS-OLD", PNG, "old.png");
  const oldSecond = await save("PAS-OLD", PNG, "old-second.png", 2);
  const hidden = await save("PAS-2", PNG, "hidden.png");
  db.run(
    `INSERT INTO question (id, item_id, session_id, body, status, created_at)
     VALUES ('question', 'PAS-OLD', 'session-mine', 'Review', 'open', 0)`,
  );
  db.run(
    `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at)
     VALUES ('question', 'PAS-OLD', 'visual-proof', ?, 0)`,
    [JSON.stringify([old.id])],
  );
  await saveVisualReviewMarks(sqliteDb(db), [
    {
      id: MARK_ID,
      questionId: "question",
      evidenceId: old.id,
      sizeBytes: MARK.byteLength,
      sha256: "0".repeat(64),
      createdAt: 0,
    },
  ]);
  writeFileSync(evidencePath(evidenceDir, MARK_ID), MARK, { mode: 0o600 });

  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const access = createWorkspaceAccess({
    db,
    publicUrl: `http://127.0.0.1:${port}`,
    clientId: "fixture",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds,
      }),
    },
  });
  const server = startServer({
    port,
    hostname: "127.0.0.1",
    db,
    workspaceAccess: access,
    evidenceDir,
  });
  const session = await issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "member",
    now: Date.now(),
  });
  const cookie = `${WORKSPACE_COOKIE}=${session.token}`;
  return {
    db,
    video,
    old,
    oldSecond,
    hidden,
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    signedIn: (init: RequestInit & { headers?: Record<string, string> } = {}) => ({
      ...init,
      headers: { cookie, ...init.headers },
    }),
    async revoke() {
      teamIds = ["other-team"];
      await member();
    },
    async close() {
      await server.stop(true);
      db.close();
    },
  };
}

test("evidence metadata and files share /api/evidence/ through the composed server without shadowing", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/api/evidence",
      `/api/evidence/${f.video.id}/metadata`,
      `/api/evidence/${f.video.id}`,
    ])
      expect((await fetch(f.url(path))).status).toBe(401);

    const gallery = await fetch(f.url("/api/evidence"), f.signedIn());
    expect(gallery.status).toBe(200);
    expect(gallery.headers.get("cache-control")).toBe("no-store");
    expect(gallery.headers.get("paws-generated-at")).not.toBeNull();
    const listed = (await gallery.json()) as { evidence: Evidence[] };
    expect(listed.evidence.map((entry) => [entry.id, entry.itemId, entry.checkId])).toEqual([
      [f.video.id, "PAS-1", "visual-proof"],
    ]);

    const metadata = await fetch(f.url(`/api/evidence/${f.video.id}/metadata`), f.signedIn());
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toContain("application/json");
    const etag = metadata.headers.get("etag")!;
    expect(etag).toStartWith('W/"');
    const page = (await metadata.json()) as { evidence: Evidence & { kind: string } };
    expect(page.evidence).toMatchObject({ id: f.video.id, itemId: "PAS-1", kind: "video" });
    const unchanged = await fetch(
      f.url(`/api/evidence/${f.video.id}/metadata`),
      f.signedIn({ headers: { "If-None-Match": etag } }),
    );
    expect(unchanged.status).toBe(304);

    const file = await fetch(f.url(`/api/evidence/${f.video.id}`), f.signedIn());
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("video/webm");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(file.headers.get("accept-ranges")).toBe("bytes");
    expect(file.headers.get("content-disposition")).toStartWith('inline; filename="flow.webm"');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WEBM);
    const range = await fetch(
      f.url(`/api/evidence/${f.video.id}`),
      f.signedIn({ headers: { range: "bytes=2-5" } }),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 2-5/${WEBM.byteLength}`);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(WEBM.subarray(2, 6));
    const head = await fetch(f.url(`/api/evidence/${f.video.id}`), f.signedIn({ method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(WEBM.byteLength));

    for (const path of [`/api/evidence/${f.video.id}/other`, `/api/evidence/${f.video.id}/`]) {
      const response = await fetch(f.url(path), f.signedIn());
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    expect((await fetch(f.url("/api/evidence"), f.signedIn({ method: "POST" }))).status).not.toBe(
      200,
    );
  } finally {
    await f.close();
  }
});

test("older authorized evidence, marked images and hidden evidence keep their answers", async () => {
  const f = await fixture();
  try {
    const old = await fetch(f.url(`/api/evidence/${f.old.id}/metadata`), f.signedIn());
    expect(old.status).toBe(200);
    const page = (await old.json()) as { evidence: Evidence; related: Evidence[] };
    expect(page.evidence.itemId).toBe("PAS-OLD");
    expect(page.related.map((entry) => [entry.id, entry.attempt])).toEqual([
      [f.old.id, 1],
      [f.oldSecond.id, 2],
    ]);
    expect((await fetch(f.url(`/api/evidence/${f.old.id}`), f.signedIn())).status).toBe(200);

    const mark = await fetch(f.url(`/api/evidence/${MARK_ID}`), f.signedIn());
    expect(mark.status).toBe(200);
    expect(mark.headers.get("content-type")).toBe("image/png");
    expect(mark.headers.get("content-disposition")).toContain('filename="marked-old.png"');
    expect(new Uint8Array(await mark.arrayBuffer())).toEqual(MARK);
    expect((await fetch(f.url(`/api/evidence/${MARK_ID}/metadata`), f.signedIn())).status).toBe(
      404,
    );

    const hidden = await fetch(f.url(`/api/evidence/${f.hidden.id}/metadata`), f.signedIn());
    const unknown = await fetch(
      f.url("/api/evidence/01ARZ3NDEKTSV4RRFFQ69G5FAV/metadata"),
      f.signedIn(),
    );
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await hidden.text()).toBe(await unknown.text());
    expect((await fetch(f.url(`/api/evidence/${f.hidden.id}`), f.signedIn())).status).toBe(404);

    const shortlink = await fetch(f.url(`/evidence/${f.old.id}?from=linear`), {
      ...f.signedIn(),
      redirect: "manual",
    });
    expect(shortlink.status).toBe(307);
    expect(shortlink.headers.get("location")).toBe(`/dashboard/evidence/${f.old.id}?from=linear`);
  } finally {
    await f.close();
  }
});

test("evidence metadata and files follow membership changes", async () => {
  const f = await fixture();
  try {
    const before = await fetch(f.url(`/api/evidence/${f.video.id}/metadata`), f.signedIn());
    const etag = before.headers.get("etag")!;
    expect(before.status).toBe(200);
    await f.revoke();
    await Bun.sleep(1_100);
    const revoked = await fetch(
      f.url(`/api/evidence/${f.video.id}/metadata`),
      f.signedIn({ headers: { "If-None-Match": etag } }),
    );
    expect(revoked.status).toBe(404);
    expect((await fetch(f.url(`/api/evidence/${f.video.id}`), f.signedIn())).status).toBe(404);
    const gallery = (await (await fetch(f.url("/api/evidence"), f.signedIn())).json()) as {
      evidence: Evidence[];
    };
    expect(gallery.evidence.map((entry) => entry.id)).toEqual([f.hidden.id]);
  } finally {
    await f.close();
  }
});
