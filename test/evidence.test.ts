import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEvidence, insertQueuedItem, migrate, openDatabase } from "../src/db";
import {
  createEvidenceStore,
  EvidenceRejectedError,
  evidencePath,
  handleEvidenceRequest,
  parseRange,
  sniffMedia,
  type EvidenceInput,
} from "../src/evidence";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { createProjectFixture } from "./local/project-fixture";

const HEAD = "a".repeat(40);
const text = (value: string) => [...new TextEncoder().encode(value)];
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], text("IHDR-png-body"));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], text("jpeg-body"));
const WEBP = bytes(text("RIFF"), [0x10, 0, 0, 0], text("WEBPVP8 body"));
const MP4 = bytes([0, 0, 0, 0x18], text("ftypisom"), [0, 0, 2, 0], text("isomiso2mp41"));
const ebml = (docType: string) =>
  bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | docType.length],
    text(docType),
    [0x42, 0x87, 0x81, 0x04],
  );
const WEBM = ebml("webm");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(limits?: { video: number; image: number }) {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "session-visible" });
  insertQueuedItem(db, { id: "hidden", sessionKey: "session-hidden" });
  const home = mkdtempSync(join(tmpdir(), "paws-evidence-"));
  roots.push(home);
  const root = join(home, "evidence");
  const store = createEvidenceStore({
    db,
    root,
    now: () => 1_700_000_000_000,
    ...(limits ? { limits } : {}),
  });
  const input = (source: Uint8Array, extra: Partial<EvidenceInput> = {}): EvidenceInput => ({
    itemId: "item",
    runId: "run-1",
    checkId: "e2e",
    attempt: 2,
    displayName: "checkout.png",
    headCommit: HEAD,
    source: new Blob([source]),
    ...extra,
  });
  return { db, root, store, input };
}

describe("evidence store", () => {
  test("a stored file gets a row with every field, mode 0600 in a 0700 directory", async () => {
    const { db, root, store, input } = harness();
    const saved = await store.save(input(PNG));
    expect(saved.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(getEvidence(db, saved.id)).toEqual({
      id: saved.id,
      itemId: "item",
      runId: "run-1",
      checkId: "e2e",
      attempt: 2,
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      displayName: "checkout.png",
      headCommit: HEAD,
      createdAt: 1_700_000_000_000,
      assetUrl: null,
    });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(evidencePath(root, saved.id)).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual([saved.id]);
  });

  test("the media type comes from the content, not the name", async () => {
    const { store, input } = harness();
    const cases: [Uint8Array, string, string][] = [
      [WEBM, "clip.mp4", "video/webm"],
      [MP4, "clip.webm", "video/mp4"],
      [JPEG, "shot.png", "image/jpeg"],
      [WEBP, "shot.jpg", "image/webp"],
      [PNG, "shot.webp", "image/png"],
    ];
    for (const [source, displayName, mediaType] of cases)
      expect((await store.save(input(source, { displayName }))).mediaType).toBe(mediaType as never);
  });

  test("SVG and other types are refused whatever they are called", async () => {
    const { db, root, store, input } = harness();
    const refused = [
      bytes(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
      bytes(text("<!DOCTYPE html><html></html>")),
      ebml("matroska"),
      bytes([0, 0, 0, 0x18], text("ftypheic"), [0, 0, 0, 0]),
      bytes(text("GIF89a......")),
    ];
    for (const source of refused) {
      const error = await store
        .save(input(source, { displayName: "evidence.png" }))
        .catch((e) => e);
      expect(error).toBeInstanceOf(EvidenceRejectedError);
      expect((error as EvidenceRejectedError).reason).toBe("type");
    }
    expect(readdirSync(root)).toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM evidence").get()).toEqual({ n: 0 });
  });

  test("a file over the cap for its kind is refused", async () => {
    const { root, store, input } = harness({ video: 64, image: PNG.byteLength - 1 });
    const error = await store.save(input(PNG)).catch((e) => e);
    expect((error as EvidenceRejectedError).reason).toBe("size");
    const huge = bytes([...WEBM], new Array<number>(100).fill(0));
    expect(((await store.save(input(huge)).catch((e) => e)) as EvidenceRejectedError).reason).toBe(
      "size",
    );
    expect(readdirSync(root)).toEqual([]);
    expect((await store.save(input(WEBM))).mediaType).toBe("video/webm");
  });

  test("an unknown work item leaves no file behind", async () => {
    const { root, store, input } = harness();
    await expect(store.save(input(PNG, { itemId: "missing" }))).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  test("sniffMedia needs the WebM doctype, not only the EBML magic", () => {
    expect(sniffMedia(WEBM)).toBe("video/webm");
    expect(sniffMedia(ebml("matroska"))).toBeNull();
    expect(sniffMedia(new Uint8Array())).toBeNull();
  });
});

describe("GET /api/evidence/:id", () => {
  async function stored() {
    const h = harness();
    const video = await h.store.save(
      h.input(bytes([...WEBM], text("0123456789")), { displayName: 'run "one" ✓.webm' }),
    );
    const hidden = await h.store.save(h.input(PNG, { itemId: "hidden" }));
    const get = (
      id: string,
      init: RequestInit = {},
      sessionIds: string[] | null = ["session-visible"],
    ) =>
      handleEvidenceRequest(new Request(`http://paws.test/api/evidence/${id}`, init), {
        db: h.db,
        root: h.root,
        sessionIds: sessionIds ?? undefined,
      }).then((response) => response!);
    return { ...h, video, hidden, get, body: bytes([...WEBM], text("0123456789")) };
  }

  test("a full request answers 200 with private, nosniff and inline headers", async () => {
    const { video, get, body } = await stored();
    const response = await get(video.id);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get("content-type")).toBe("video/webm");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="run _one_ _.webm"; filename*=UTF-8''${encodeURIComponent('run "one" ✓.webm')}`,
    );
  });

  test("a Range request answers 206 with the requested bytes", async () => {
    const { video, get, body } = await stored();
    const response = await get(video.id, { headers: { range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body.subarray(2, 6));
    expect(response.headers.get("content-range")).toBe(`bytes 2-5/${body.byteLength}`);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const tail = await get(video.id, { headers: { range: "bytes=-3" } });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(body.subarray(body.byteLength - 3));
    const open = await get(video.id, { headers: { range: "bytes=10-" } });
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(body.subarray(10));
    const outside = await get(video.id, { headers: { range: `bytes=${body.byteLength}-` } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe(`bytes */${body.byteLength}`);
  });

  test("HEAD sends the headers without a body", async () => {
    const { video, get, body } = await stored();
    const response = await get(video.id, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("a request without a Paws session is refused", async () => {
    const { video, get } = await stored();
    const response = await get(video.id, {}, null);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("video/webm");
  });

  test("no access to the repository answers the same 404 as an unknown id", async () => {
    const { hidden, get } = await stored();
    const denied = await get(hidden.id);
    const unknown = await get("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const malformed = await get("..%2Fpaws.db");
    for (const response of [denied, unknown, malformed]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(await denied.text()).toBe(await unknown.text());
    expect(await malformed.text()).toBe(
      await get("01ARZ3NDEKTSV4RRFFQ69G5FAV").then((r) => r.text()),
    );
  });

  test("parseRange ignores malformed and multi-part ranges", () => {
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
  });
});

test("the server refuses evidence without a session and hides it from members without access", async () => {
  const f = createProjectFixture();
  const home = mkdtempSync(join(tmpdir(), "paws-evidence-server-"));
  roots.push(home);
  const evidenceDir = join(home, "evidence");
  insertQueuedItem(f.db, { id: "evidence-item", sessionKey: "session-elsewhere" });
  const saved = await createEvidenceStore({ db: f.db, root: evidenceDir }).save({
    itemId: "evidence-item",
    runId: "run",
    checkId: "e2e",
    attempt: 1,
    displayName: "shot.png",
    headCommit: HEAD,
    source: new Blob([PNG]),
  });
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const access = createWorkspaceAccess({
    db: f.db,
    publicUrl: origin,
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
        teamIds: ["team"],
      }),
    },
  });
  const server = startServer({
    port,
    hostname: "127.0.0.1",
    db: f.db,
    workspaceAccess: access,
    evidenceDir,
  });
  const session = issueWorkspaceSession(f.db, { ...f.actor, now: Date.now() });
  const url = (id: string) => `http://127.0.0.1:${server.port}/api/evidence/${id}`;
  try {
    expect((await fetch(url(saved.id))).status).toBe(401);
    const cookie = { cookie: `${WORKSPACE_COOKIE}=${session.token}` };
    const denied = await fetch(url(saved.id), { headers: cookie });
    const unknown = await fetch(url("01ARZ3NDEKTSV4RRFFQ69G5FAV"), { headers: cookie });
    expect(denied.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await denied.text()).toBe(await unknown.text());
  } finally {
    await server.stop(true);
    f.db.close();
  }
});
