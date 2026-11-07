import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEvidenceObject, insertQueuedItem, migrate, openDatabase } from "../src/db";
import {
  createEvidenceStore,
  EvidenceRejectedError,
  handleEvidenceRequest,
  readEvidenceBytes,
  uploadLocalEvidence,
  type EvidenceObjects,
} from "../src/evidence";
import { createFakeRunFileObjects, RUN_FILE_CHUNK_BYTES } from "../src/run-files";

const HEAD = "b".repeat(40);
const WEBM = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
]);
const VIDEO = new Uint8Array(RUN_FILE_CHUNK_BYTES * 2 + 1000);
VIDEO.set(WEBM);
for (let index = WEBM.length; index < VIDEO.length; index++) VIDEO[index] = index % 251;

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function instance(db: ReturnType<typeof openDatabase>, objects: EvidenceObjects) {
  const home = mkdtempSync(join(tmpdir(), "paws-evidence-objects-"));
  homes.push(home);
  const root = join(home, "evidence");
  const store = createEvidenceStore({ db, root, objects });
  const get = (id: string, headers: Record<string, string> = {}) =>
    handleEvidenceRequest(new Request(`http://acme.test/api/evidence/${id}`, { headers }), {
      db,
      root,
      objects,
      sessionIds: ["session-acme"],
    }).then((response) => response!);
  return { root, store, get };
}

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item-acme", sessionKey: "session-acme" });
  const s3 = createFakeRunFileObjects();
  const save = (store: ReturnType<typeof instance>["store"], source: Uint8Array) =>
    store.save({
      itemId: "item-acme",
      runId: "run-acme",
      checkId: "e2e/checkout",
      attempt: 1,
      displayName: "checkout.webm",
      headCommit: HEAD,
      source: new Blob([source]),
    });
  return { db, s3, save };
}

describe("evidence in the run file object store", () => {
  test("evidence written by one instance is served by another", async () => {
    const { db, s3, save } = setup();
    const a = instance(db, () => s3);
    const b = instance(db, () => s3);
    const saved = await save(a.store, VIDEO);
    const prefix = `evidence/item-acme/${HEAD}/e2e%2Fcheckout/${saved.id}`;
    expect(s3.writes).toEqual([`${prefix}/0`, `${prefix}/1`, `${prefix}/2`]);
    expect(existsSync(join(a.root, saved.id))).toBe(false);

    const full = await b.get(saved.id);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(VIDEO.length));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(VIDEO);

    const start = RUN_FILE_CHUNK_BYTES - 10;
    const end = RUN_FILE_CHUNK_BYTES * 2 + 5;
    const partial = await b.get(saved.id, { range: `bytes=${start}-${end}` });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes ${start}-${end}/${VIDEO.length}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(VIDEO.slice(start, end + 1));
  });

  test("a missing object answers 404", async () => {
    const { db, s3, save } = setup();
    const a = instance(db, () => s3);
    const saved = await save(a.store, WEBM);
    s3.objects.clear();
    expect((await a.get(saved.id)).status).toBe(404);
  });

  test("a rejected file leaves no chunks behind", async () => {
    const { db, s3, save } = setup();
    const a = instance(db, () => s3);
    const text = new Uint8Array(RUN_FILE_CHUNK_BYTES + 5).fill(0x41);
    await expect(save(a.store, text)).rejects.toBeInstanceOf(EvidenceRejectedError);
    expect(s3.objects.size).toBe(0);
    expect(s3.deletes.length).toBe(2);
  });

  test("with S3 off the file stays local, as before", async () => {
    const { db, s3, save } = setup();
    const a = instance(db, () => null);
    const saved = await save(a.store, VIDEO);
    expect(s3.writes).toEqual([]);
    expect(getEvidenceObject(db, saved.id)).toBeNull();
    expect(existsSync(join(a.root, saved.id))).toBe(true);
    expect(new Uint8Array(await (await a.get(saved.id)).arrayBuffer())).toEqual(VIDEO);
  });

  test("local evidence is uploaded once on startup and served from S3 afterwards", async () => {
    const { db, s3, save } = setup();
    let configured = false;
    const objects = () => (configured ? s3 : null);
    const a = instance(db, objects);
    const saved = await save(a.store, VIDEO);
    expect(await uploadLocalEvidence(db, { root: a.root, objects })).toBe(0);

    configured = true;
    expect(await uploadLocalEvidence(db, { root: a.root, objects }, () => 42)).toBe(1);
    expect(getEvidenceObject(db, saved.id)).toMatchObject({
      sizeBytes: VIDEO.length,
      storedAt: 42,
    });
    expect(await uploadLocalEvidence(db, { root: a.root, objects })).toBe(0);
    expect(s3.writes.length).toBe(3);
    expect(existsSync(join(a.root, saved.id))).toBe(true);

    rmSync(join(a.root, saved.id));
    const b = instance(db, objects);
    expect(new Uint8Array(await (await b.get(saved.id)).arrayBuffer())).toEqual(VIDEO);
    expect(await readEvidenceBytes(db, { root: b.root, objects }, saved.id)).toEqual(VIDEO);
  });
});
