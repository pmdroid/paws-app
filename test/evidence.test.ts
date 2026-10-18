import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getEvidence, insertQueuedItem, insertRun } from "../src/db";
import {
  EvidenceRejected,
  evidenceFile,
  handleEvidenceRequest,
  parseRange,
  sniffEvidence,
  storeEvidence,
} from "../src/evidence";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { tempDb, tempHome } from "./helpers";
import { createProjectFixture } from "./local/project-fixture";

const HEAD = "a".repeat(40);

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 64);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 64);
const WEBP = bytes([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")], 64);
const MP4 = bytes([0, 0, 0, 0x20, ...ascii("ftypisom"), 0, 0, 2, 0], 64);
const WEBM = bytes(
  [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")],
  64,
);
const MATROSKA = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, ...ascii("matroska")], 64);
const QUICKTIME = bytes([0, 0, 0, 0x14, ...ascii("ftypqt  ")], 64);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function bytes(prefix: number[], length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.max(length, prefix.length));
  out.set(prefix);
  for (let index = prefix.length; index < out.length; index++) out[index] = index % 251;
  return out;
}

function seed(db: Database, sessionKey = "session-a") {
  const item = insertQueuedItem(db, { id: "item-1", sessionKey });
  const run = insertRun(db, { itemId: item.id, now: 1 });
  return { item, run };
}

function save(db: Database, dir: string, runId: string, data: Uint8Array, name = "clip.webm") {
  return storeEvidence({
    db,
    dir,
    itemId: "item-1",
    runId,
    checkId: "ui/login",
    attempt: 2,
    displayName: name,
    headCommit: HEAD,
    bytes: data,
    now: 1_700_000_000_000,
  });
}

function get(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1/api/evidence/${id}`, { headers });
}

describe("evidence media", () => {
  test("recognizes the five allowed types by content", () => {
    expect(sniffEvidence(PNG)).toBe("image/png");
    expect(sniffEvidence(JPEG)).toBe("image/jpeg");
    expect(sniffEvidence(WEBP)).toBe("image/webp");
    expect(sniffEvidence(MP4)).toBe("video/mp4");
    expect(sniffEvidence(WEBM)).toBe("video/webm");
  });

  test("refuses SVG, Matroska, QuickTime and text", () => {
    expect(sniffEvidence(SVG)).toBeNull();
    expect(sniffEvidence(MATROSKA)).toBeNull();
    expect(sniffEvidence(QUICKTIME)).toBeNull();
    expect(sniffEvidence(new TextEncoder().encode("hello"))).toBeNull();
  });
});

describe("evidence store", () => {
  test("stores a row with every field and a 0600 file in a 0700 directory", () => {
    const db = tempDb();
    const { run } = seed(db);
    const dir = join(tempHome(), "evidence");
    const record = save(db, dir, run.id, WEBM, "../../screens/login.png");
    expect(record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(getEvidence(db, record.id)).toEqual({
      id: record.id,
      itemId: "item-1",
      runId: run.id,
      checkId: "ui/login",
      attempt: 2,
      mediaType: "video/webm",
      size: WEBM.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(WEBM).digest("hex"),
      displayName: "login.png",
      headCommit: HEAD,
      createdAt: 1_700_000_000_000,
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(evidenceFile(dir, record.id)).mode & 0o777).toBe(0o600);
    expect(new Uint8Array(readFileSync(evidenceFile(dir, record.id)))).toEqual(WEBM);
  });

  test("ignores the file name: an SVG named .png is refused", () => {
    const db = tempDb();
    const { run } = seed(db);
    const dir = join(tempHome(), "evidence");
    expect(() => save(db, dir, run.id, SVG, "shot.png")).toThrow(EvidenceRejected);
    try {
      save(db, dir, run.id, SVG, "shot.png");
    } catch (error) {
      expect((error as EvidenceRejected).reason).toBe("type");
    }
  });

  test("refuses a file over the cap for its type", () => {
    const db = tempDb();
    const { run } = seed(db);
    const dir = join(tempHome(), "evidence");
    const caps = { video: 128, image: 32 };
    const attempt = (data: Uint8Array) =>
      storeEvidence({
        db,
        dir,
        itemId: "item-1",
        runId: run.id,
        checkId: "ui",
        attempt: 1,
        displayName: "x",
        headCommit: HEAD,
        bytes: data,
        caps,
      });
    expect(() => attempt(PNG)).toThrow("over the size cap");
    expect(() => attempt(bytes([...WEBM], 129))).toThrow("over the size cap");
    expect(attempt(WEBM).size).toBe(64);
  });

  test("refuses a run from another work item", () => {
    const db = tempDb();
    seed(db);
    insertQueuedItem(db, { id: "item-2" });
    const other = insertRun(db, { itemId: "item-2", now: 1 });
    expect(() => save(db, join(tempHome(), "evidence"), other.id, PNG)).toThrow("does not belong");
  });
});

describe("GET /api/evidence/:id", () => {
  function fixture() {
    const db = tempDb();
    const { run } = seed(db);
    const dir = join(tempHome(), "evidence");
    const record = save(db, dir, run.id, WEBM);
    return { db, dir, record, options: { db, dir, sessionIds: ["session-a"] } };
  }

  test("a full request is 200 with private, inline headers", async () => {
    const f = fixture();
    const response = handleEvidenceRequest(get(f.record.id), f.options);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/webm");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toStartWith('inline; filename="clip.webm"');
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("64");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBM);
    const head = handleEvidenceRequest(
      new Request(get(f.record.id), { method: "HEAD" }),
      f.options,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("64");
    const post = handleEvidenceRequest(
      new Request(get(f.record.id), { method: "POST" }),
      f.options,
    );
    expect(post.status).toBe(405);
  });

  test("a Range request is 206 with the requested bytes", async () => {
    const f = fixture();
    const response = handleEvidenceRequest(get(f.record.id, { range: "bytes=10-19" }), f.options);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-19/64");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-type")).toBe("video/webm");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WEBM.slice(10, 20));
    const tail = handleEvidenceRequest(get(f.record.id, { range: "bytes=-4" }), f.options);
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(WEBM.slice(60));
    const past = handleEvidenceRequest(get(f.record.id, { range: "bytes=64-" }), f.options);
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */64");
  });

  test("parses ranges like RFC 9110", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-100", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
  });

  test("no access answers exactly like an unknown id", async () => {
    const f = fixture();
    const hidden = handleEvidenceRequest(get(f.record.id), { ...f.options, sessionIds: ["other"] });
    const unknown = handleEvidenceRequest(get("01HZZZZZZZZZZZZZZZZZZZZZZZ"), f.options);
    const malformed = handleEvidenceRequest(get("..%2Fpaws.db"), f.options);
    for (const response of [hidden, unknown, malformed]) expect(response.status).toBe(404);
    expect([...hidden.headers]).toEqual([...unknown.headers]);
    expect(await hidden.text()).toBe(await unknown.text());
  });

  test("a file changed on disk is not served", () => {
    const f = fixture();
    writeFileSync(evidenceFile(f.dir, f.record.id), "short");
    expect(handleEvidenceRequest(get(f.record.id), f.options).status).toBe(404);
  });
});

describe("evidence route on the Paws server", () => {
  test("refuses requests without a Paws session", async () => {
    const db = tempDb();
    const { run } = seed(db);
    const dir = join(tempHome(), "evidence");
    const record = save(db, dir, run.id, PNG, "shot.png");
    const server = startServer({ port: 0, hostname: "127.0.0.1", db, evidenceDir: dir });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/evidence/${record.id}`);
      expect(response.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("a signed-in member gets 401 without the cookie and 404 outside their sessions", async () => {
    const f = createProjectFixture();
    const { run } = seed(f.db, "not-yours");
    const dir = join(tempHome(), "evidence");
    const record = save(f.db, dir, run.id, PNG, "shot.png");
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
      evidenceDir: dir,
    });
    const session = issueWorkspaceSession(f.db, { ...f.actor, now: Date.now() });
    const url = `${origin}/api/evidence/${record.id}`;
    try {
      await Bun.sleep(0);
      expect((await fetch(url)).status).toBe(401);
      const signedIn = { cookie: `${WORKSPACE_COOKIE}=${session.token}` };
      const hidden = await fetch(url, { headers: signedIn });
      const unknown = await fetch(`${origin}/api/evidence/01HZZZZZZZZZZZZZZZZZZZZZZZ`, {
        headers: signedIn,
      });
      expect(hidden.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await hidden.text()).toBe(await unknown.text());
    } finally {
      await server.stop(true);
    }
  });
});
