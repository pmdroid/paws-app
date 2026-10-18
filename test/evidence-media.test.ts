import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getEvidence,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
} from "../src/db";
import {
  createEvidenceMediaStore,
  EvidenceRefusedError,
  handleEvidenceRequest,
  parseRange,
  sniffMediaType,
} from "../src/evidence-media";
import { createLinearMembershipReads } from "../src/linear";
import { startServer } from "../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { tempDb, tempHome } from "./helpers";

const HEAD = "a".repeat(40);

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 100);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 100);
const WEBP = bytes([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")], 100);
const WEBM = bytes(
  [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")],
  1000,
);
const MP4 = bytes([0, 0, 0, 0x18, ...ascii("ftypisom"), 0, 0, 2, 0, ...ascii("isommp41")], 1000);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

function ascii(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0));
}

/** The header followed by a counting pattern, so ranges are easy to check. */
function bytes(header: number[], length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index++) out[index] = index % 251;
  out.set(header);
  return out;
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function seedItem(db: Database, now: number) {
  const item = insertQueuedItem(db, { id: "item", sessionKey: "session-item", title: "Item", now });
  const run = beginImplementRun(db, item.id, now).run;
  return { item, run };
}

async function file(contents: Uint8Array, name: string): Promise<Bun.BunFile> {
  const path = join(tempHome(), name);
  await Bun.write(path, contents);
  return Bun.file(path);
}

function store(db: Database, limits?: { videoBytes: number; imageBytes: number }) {
  const dir = join(tempHome(), "evidence");
  return createEvidenceMediaStore({
    db,
    dir,
    now: () => 1_700_000_000_000,
    ...(limits ? { limits } : {}),
  });
}

test("content decides the type, not the name", () => {
  expect(sniffMediaType(PNG)).toBe("image/png");
  expect(sniffMediaType(JPEG)).toBe("image/jpeg");
  expect(sniffMediaType(WEBP)).toBe("image/webp");
  expect(sniffMediaType(WEBM)).toBe("video/webm");
  expect(sniffMediaType(MP4)).toBe("video/mp4");
  expect(sniffMediaType(SVG)).toBeNull();
  expect(sniffMediaType(new TextEncoder().encode("GIF89a......"))).toBeNull();
  const matroska = bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, ...ascii("matroska")],
    100,
  );
  expect(sniffMediaType(matroska)).toBeNull();
  const quicktime = bytes([0, 0, 0, 0x14, ...ascii("ftypqt  "), 0, 0, 2, 0, ...ascii("qt  ")], 100);
  expect(sniffMediaType(quicktime)).toBeNull();
  const avif = bytes([0, 0, 0, 0x14, ...ascii("ftypavif"), 0, 0, 0, 0, ...ascii("mif1")], 100);
  expect(sniffMediaType(avif)).toBeNull();
});

test("a stored video gets its row and a 0600 file in a 0700 directory", async () => {
  const db = tempDb();
  closers.push(() => db.close());
  const { item, run } = seedItem(db, Date.now());
  const evidence = store(db);
  const row = await evidence.save({
    itemId: item.id,
    runId: run.id,
    checkId: "ui-smoke",
    attempt: 2,
    displayName: "Login flow\u0007.webm",
    headCommit: HEAD,
    file: await file(WEBM, "recording.bin"),
  });
  expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(getEvidence(db, row.id)).toEqual({
    id: row.id,
    itemId: item.id,
    runId: run.id,
    checkId: "ui-smoke",
    attempt: 2,
    mediaType: "video/webm",
    sizeBytes: WEBM.length,
    sha256: new Bun.CryptoHasher("sha256").update(WEBM).digest("hex"),
    displayName: "Login flow.webm",
    headCommit: HEAD,
    createdAt: 1_700_000_000_000,
  });
  expect(statSync(evidence.dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(evidence.dir, row.id)).mode & 0o777).toBe(0o600);
  expect(readdirSync(evidence.dir)).toEqual([row.id]);
  expect(new Uint8Array(await Bun.file(join(evidence.dir, row.id)).arrayBuffer())).toEqual(WEBM);
});

test("SVG and other types are refused even with an image name", async () => {
  const db = tempDb();
  closers.push(() => db.close());
  const { item, run } = seedItem(db, Date.now());
  const evidence = store(db);
  const input = { itemId: item.id, runId: run.id, checkId: "c", attempt: 1, headCommit: HEAD };
  for (const contents of [SVG, new TextEncoder().encode("plain text")]) {
    const error = await evidence
      .save({ ...input, displayName: "shot.png", file: await file(contents, "shot.png") })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvidenceRefusedError);
    expect((error as EvidenceRefusedError).reason).toBe("type");
  }
  const png = await evidence.save({
    ...input,
    displayName: "named.svg",
    file: await file(PNG, "named.svg"),
  });
  expect(png.mediaType).toBe("image/png");
  expect(db.query("SELECT count(*) AS n FROM evidence").get()).toEqual({ n: 1 });
});

test("a file over its size cap is refused and nothing is kept", async () => {
  const db = tempDb();
  closers.push(() => db.close());
  const { item, run } = seedItem(db, Date.now());
  const evidence = store(db, { videoBytes: 999, imageBytes: 99 });
  const input = { itemId: item.id, runId: run.id, checkId: "c", attempt: 1, headCommit: HEAD };
  // A 100-byte PNG is under the video cap but over the image cap.
  for (const [contents, name] of [
    [WEBM, "big.webm"],
    [PNG, "big.png"],
  ] as const) {
    const error = await evidence
      .save({ ...input, displayName: name, file: await file(contents, name) })
      .catch((caught: unknown) => caught);
    expect((error as EvidenceRefusedError).reason).toBe("size");
  }
  expect(db.query("SELECT count(*) AS n FROM evidence").get()).toEqual({ n: 0 });
  expect(existsSync(evidence.dir)).toBe(false);
});

test("parseRange reads one byte range", () => {
  expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
  expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
  expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
  expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  expect(parseRange("items=0-1", 100)).toBeNull();
  expect(parseRange("bytes=9-1", 100)).toBeNull();
});

test("the handler streams with Range and hides what the member cannot see", async () => {
  const db = tempDb();
  closers.push(() => db.close());
  const { item, run } = seedItem(db, Date.now());
  const evidence = store(db);
  const row = await evidence.save({
    itemId: item.id,
    runId: run.id,
    checkId: "c",
    attempt: 1,
    displayName: 'Résumé "flow".mp4',
    headCommit: HEAD,
    file: await file(MP4, "x"),
  });
  let allowed = true;
  const get = (id: string, headers: Record<string, string> = {}, method = "GET") =>
    handleEvidenceRequest(new Request(`http://paws.test/api/evidence/${id}`, { method, headers }), {
      db,
      dir: evidence.dir,
      canRead: () => allowed,
    });

  const full = await get(row.id);
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(full.headers.get("cache-control")).toBe("private, no-store");
  expect(full.headers.get("x-content-type-options")).toBe("nosniff");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("content-length")).toBe(String(MP4.length));
  expect(full.headers.get("content-disposition")).toBe(
    `inline; filename="R_sum_ _flow_.mp4"; filename*=UTF-8''${encodeURIComponent('Résumé "flow".mp4')}`,
  );
  expect(new Uint8Array(await full.arrayBuffer())).toEqual(MP4);

  const partial = await get(row.id, { range: "bytes=100-199" });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe(`bytes 100-199/${MP4.length}`);
  expect(partial.headers.get("content-length")).toBe("100");
  expect(partial.headers.get("content-type")).toBe("video/mp4");
  expect(partial.headers.get("cache-control")).toBe("private, no-store");
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(MP4.subarray(100, 200));

  const tail = await get(row.id, { range: "bytes=-24" });
  expect(tail.status).toBe(206);
  expect(new Uint8Array(await tail.arrayBuffer())).toEqual(MP4.subarray(MP4.length - 24));

  const stale = await get(row.id, { range: "bytes=0-9", "if-range": '"other"' });
  expect(stale.status).toBe(200);

  const beyond = await get(row.id, { range: `bytes=${MP4.length}-` });
  expect(beyond.status).toBe(416);
  expect(beyond.headers.get("content-range")).toBe(`bytes */${MP4.length}`);

  const head = await get(row.id, {}, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(MP4.length));

  expect((await get(row.id, {}, "DELETE")).status).toBe(405);

  const unknown = await get("01HZZZZZZZZZZZZZZZZZZZZZZZ");
  allowed = false;
  const hidden = await get(row.id);
  expect(hidden.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(await hidden.text()).toBe(await unknown.text());
  expect([...hidden.headers]).toEqual([...unknown.headers]);
  expect((await get("../paws.db")).status).toBe(404);
});

test("the server needs a Paws session and repository access", async () => {
  const db = tempDb();
  const now = Date.now();
  putWorkspaceUser(db, { id: "owner", linearUserId: "owner", name: "Owner", email: "o@x.invalid" });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Evidence",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const [id, teamIds] of [
    ["member", ["team"]],
    ["outside", ["outside"]],
  ] as const) {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@x.invalid` });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds,
      now,
    });
  }
  const { item, run } = seedItem(db, now);
  recordLinearInstallation(db, {
    sessionId: item.sessionKey!,
    organizationId: "org",
    teamId: "team",
    oauthClientId: "client",
    appUserId: "app",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, item.sessionKey!, item.delegationId);
  bindWorkItemRepository(db, item.id, {
    owner: "fixture",
    repo: "allowed",
    remoteUrl: "https://example.invalid/fixture/allowed",
  });
  replaceWorkspaceRepositories(db, {
    workspaceId: "workspace",
    actorId: "owner",
    repositories: [{ repository: "fixture/allowed", teamId: "team" }],
    now,
  });
  const evidence = createEvidenceMediaStore({ db, dir: join(tempHome(), "evidence") });
  const row = await evidence.save({
    itemId: item.id,
    runId: run.id,
    checkId: "c",
    attempt: 1,
    displayName: "shot.png",
    headCommit: HEAD,
    file: await file(PNG, "shot.png"),
  });
  const ready = Promise.withResolvers<ReturnType<typeof createWorkspaceAccess>>();
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    statusEnv: {},
    workspaceAccess: ready.promise,
    evidenceMediaDir: evidence.dir,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  ready.resolve(
    createWorkspaceAccess({
      db,
      publicUrl: origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Evidence" },
      memberships: createLinearMembershipReads({
        async query() {
          throw new Error("Unexpected hosted membership call");
        },
      }),
    }),
  );
  await ready.promise;
  closers.push(() => db.close());
  closers.push(() => server.stop(true));
  const cookie = (userId: string) =>
    `${WORKSPACE_COOKIE}=${issueWorkspaceSession(db, { workspaceId: "workspace", userId, now }).token}`;
  const url = (id: string) => `${origin}/api/evidence/${id}`;

  expect((await fetch(url(row.id))).status).toBe(401);

  const member = await fetch(url(row.id), {
    headers: { cookie: cookie("member"), range: "bytes=0-7" },
  });
  expect(member.status).toBe(206);
  expect(member.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await member.arrayBuffer())).toEqual(PNG.subarray(0, 8));
  const whole = await fetch(url(row.id), { headers: { cookie: cookie("member") } });
  expect(whole.status).toBe(200);
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(PNG);

  const outside = await fetch(url(row.id), { headers: { cookie: cookie("outside") } });
  const unknown = await fetch(url("01HZZZZZZZZZZZZZZZZZZZZZZZ"), {
    headers: { cookie: cookie("member") },
  });
  expect(outside.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(await outside.text()).toBe(await unknown.text());

  // The repository is no longer linked to the member's team.
  replaceWorkspaceRepositories(db, {
    workspaceId: "workspace",
    actorId: "owner",
    repositories: [{ repository: "fixture/other", teamId: "team" }],
    now,
  });
  expect((await fetch(url(row.id), { headers: { cookie: cookie("member") } })).status).toBe(404);
});
