import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelopeSubkey } from "../src/credentials";
import { getEvidenceObject, insertQueuedItem, migrate, openDatabase, sqliteDb } from "../src/db";
import {
  createEvidenceStore,
  EvidenceRejectedError,
  handleEvidenceRequest,
  readEvidenceBytes,
  uploadLocalEvidence,
  type EvidenceObjects,
} from "../src/evidence";
import {
  createFakeRunFileObjects,
  RUN_FILE_CHUNK_BYTES,
  withSealedRunFileObjects,
} from "../src/run-files";

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

async function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  await insertQueuedItem(db, { id: "item-acme", sessionKey: "session-acme" });
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
    const { db, s3, save } = await setup();
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
    const { db, s3, save } = await setup();
    const a = instance(db, () => s3);
    const saved = await save(a.store, WEBM);
    s3.objects.clear();
    expect((await a.get(saved.id)).status).toBe(404);
  });

  test("a rejected file leaves no chunks behind", async () => {
    const { db, s3, save } = await setup();
    const a = instance(db, () => s3);
    const text = new Uint8Array(RUN_FILE_CHUNK_BYTES + 5).fill(0x41);
    await expect(save(a.store, text)).rejects.toBeInstanceOf(EvidenceRejectedError);
    expect(s3.objects.size).toBe(0);
    expect(s3.deletes.length).toBe(2);
  });

  test("with S3 off the file stays local, as before", async () => {
    const { db, s3, save } = await setup();
    const a = instance(db, () => null);
    const saved = await save(a.store, VIDEO);
    expect(s3.writes).toEqual([]);
    expect(await getEvidenceObject(sqliteDb(db), saved.id)).toBeNull();
    expect(existsSync(join(a.root, saved.id))).toBe(true);
    expect(new Uint8Array(await (await a.get(saved.id)).arrayBuffer())).toEqual(VIDEO);
  });

  test("local evidence is uploaded once on startup and served from S3 afterwards", async () => {
    const { db, s3, save } = await setup();
    let configured = false;
    const objects = () => (configured ? s3 : null);
    const a = instance(db, objects);
    const saved = await save(a.store, VIDEO);
    expect(await uploadLocalEvidence(db, { root: a.root, objects })).toBe(0);

    configured = true;
    expect(await uploadLocalEvidence(db, { root: a.root, objects }, () => 42)).toBe(1);
    expect(await getEvidenceObject(sqliteDb(db), saved.id)).toMatchObject({
      sizeBytes: VIDEO.length,
      storedAt: 42,
    });
    expect(await uploadLocalEvidence(db, { root: a.root, objects })).toBe(0);
    expect(s3.writes.length).toBe(3);
    expect(existsSync(join(a.root, saved.id))).toBe(true);

    rmSync(join(a.root, saved.id));
    const b = instance(db, objects);
    expect(new Uint8Array(await (await b.get(saved.id)).arrayBuffer())).toEqual(VIDEO);
    expect(await readEvidenceBytes(sqliteDb(db), { root: b.root, objects }, saved.id)).toEqual(
      VIDEO,
    );
  });

  test("migrated evidence still reads from its local copy once S3 is turned off", async () => {
    const { db, s3, save } = await setup();
    let configured = false;
    const objects = () => (configured ? s3 : null);
    const a = instance(db, objects);
    const saved = await save(a.store, VIDEO);
    configured = true;
    expect(await uploadLocalEvidence(db, { root: a.root, objects })).toBe(1);
    configured = false;
    const response = await a.get(saved.id);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(VIDEO);
  });

  test("two instances migrating the same file keep one complete copy", async () => {
    const { db, s3, save } = await setup();
    let configured = false;
    const objects = () => (configured ? s3 : null);
    const a = instance(db, objects);
    const saved = await save(a.store, VIDEO);
    configured = true;
    let failing = false;
    const flaky = {
      ...s3,
      async write(key: string, bytes: Uint8Array) {
        if (failing) throw new Error("acme upload failed");
        await s3.write(key, bytes);
      },
    };
    const both = await Promise.all([
      uploadLocalEvidence(db, { root: a.root, objects }),
      uploadLocalEvidence(db, { root: a.root, objects: () => flaky }),
    ]);
    expect(both.reduce((left, right) => left + right)).toBe(1);
    failing = true;
    expect(await uploadLocalEvidence(db, { root: a.root, objects: () => flaky })).toBe(0);
    rmSync(join(a.root, saved.id));
    expect(new Uint8Array(await (await a.get(saved.id)).arrayBuffer())).toEqual(VIDEO);
    const prefix = (await getEvidenceObject(sqliteDb(db), saved.id))!.prefix;
    expect([...s3.objects.keys()].every((key) => key.startsWith(`${prefix}/`))).toBe(true);
  });

  test("sealed chunks hold no plaintext, and a changed or swapped chunk is not served", async () => {
    const { db, s3, save } = await setup();
    const sealed = withSealedRunFileObjects(s3, Buffer.alloc(32, 7));
    const a = instance(db, () => sealed);
    const saved = await save(a.store, VIDEO);
    const [first, second] = [...s3.objects.keys()];
    const plain = Buffer.from(VIDEO.subarray(0, 64));
    for (const bytes of s3.objects.values()) expect(Buffer.from(bytes).includes(plain)).toBe(false);
    expect(new Uint8Array(await (await a.get(saved.id)).arrayBuffer())).toEqual(VIDEO);

    const original = s3.objects.get(first!)!;
    s3.objects.set(first!, s3.objects.get(second!)!);
    expect((await a.get(saved.id)).status).toBe(404);
    const flipped = new Uint8Array(original);
    flipped[40]! ^= 1;
    s3.objects.set(first!, flipped);
    expect((await a.get(saved.id)).status).toBe(404);
  });

  test("two instances with their own sealed stores and the same envelope key share evidence", async () => {
    const { db, s3, save } = await setup();
    const secrets = (name: string) => {
      const home = mkdtempSync(join(tmpdir(), `paws-acme-${name}-`));
      homes.push(home);
      return join(home, "secrets");
    };
    const [secretsA, secretsB, secretsC] = [secrets("a"), secrets("b"), secrets("c")];
    const keyA = envelopeSubkey(secretsA, "paws-evidence-objects");
    mkdirSync(secretsB, { recursive: true, mode: 0o700 });
    copyFileSync(join(secretsA, ".envelope-key"), join(secretsB, ".envelope-key"));
    const a = instance(db, () => withSealedRunFileObjects(s3, keyA));
    const b = instance(db, () =>
      withSealedRunFileObjects(s3, envelopeSubkey(secretsB, "paws-evidence-objects")),
    );
    const saved = await save(a.store, VIDEO);
    expect(new Uint8Array(await (await b.get(saved.id)).arrayBuffer())).toEqual(VIDEO);

    const other = instance(db, () =>
      withSealedRunFileObjects(s3, envelopeSubkey(secretsC, "paws-evidence-objects")),
    );
    expect((await other.get(saved.id)).status).toBe(404);
  });
});
