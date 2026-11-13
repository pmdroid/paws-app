import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRecord } from "../src/closeout-spec";
import { createEvidenceStore } from "../src/closeout-spec/evidence";
import { closeoutRecordObjects, migrateCloseoutEvidence } from "../src/evidence";
import {
  createFakeRunFileObjects,
  createLocalRunFileObjects,
  withSealedRunFileObjects,
  type RunFileObjects,
} from "../src/run-files";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const HEAD = "c".repeat(40);
const HEX = "d".repeat(64);
const DIGEST = `sha256:${HEX}`;
const KEY = Buffer.alloc(32, 7);

const openStores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of openStores.splice(0)) await close();
});

function record(attempt: number, itemId = "quality/test"): CommandRecord {
  return {
    specVersion: "0.1",
    recordType: "command",
    itemId,
    base: "a".repeat(40),
    head: HEAD,
    policyDigest: DIGEST,
    attempt,
    evaluator: { name: "paws", version: "0.1" },
    producer: { name: "paws", version: "0.1" },
    exec: {
      argv: ["bun", "test"],
      exitCode: 0,
      timedOut: false,
      dirty: false,
      headMoved: false,
      durationMs: 4,
      truncated: false,
    },
    artifacts: [],
  };
}

const backends: Array<[string, (home: string) => RunFileObjects]> = [
  ["fake S3", () => createFakeRunFileObjects()],
  ["local", (home) => createLocalRunFileObjects("agent_session", join(home, "objects"))],
];

async function setup(backend: (home: string) => RunFileObjects) {
  const home = tempHome();
  const { db, close } = await tempStore();
  openStores.push(close);
  const sealed = withSealedRunFileObjects(backend(home), KEY);
  const storage = { root: join(home, "closeout", "evidence"), objects: () => sealed };
  const root = join(storage.root, "item-acme");
  const objects = closeoutRecordObjects(db, storage)(root);
  return { db, storage, root, objects, store: createEvidenceStore({ root, objects }) };
}

function writeLocal(root: string, attempt: number, itemId = "quality/test") {
  const file = join(root, "evidence", HEX, HEAD, ...itemId.split("/"), `${attempt}.json`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record(attempt, itemId), null, 2)}\n`);
}

describe.each(backends)("closeout evidence records in the %s object store", (_name, backend) => {
  test("a record written through the store is read back from the object store only", async () => {
    const { root, objects, store } = await setup(backend);
    expect(objects).not.toBeNull();
    await store.add(record(1));
    expect(existsSync(join(root, "evidence"))).toBe(false);
    expect(await objects!.list()).toEqual([`evidence/${HEX}/${HEAD}/quality/test/1.json`]);
    expect(await store.load()).toEqual({ records: [record(1)] });
    expect(
      await store.nextAttempt({ policyDigest: DIGEST, head: HEAD, itemId: "quality/test" }),
    ).toBe(2);
  });

  test("a record only on disk is still read next to stored ones", async () => {
    const { root, store } = await setup(backend);
    writeLocal(root, 1);
    expect((await store.load()).records).toEqual([record(1)]);
    await store.add(record(2));
    expect(existsSync(join(root, "evidence", HEX, HEAD, "quality", "test", "2.json"))).toBe(false);
    expect((await store.load()).records).toEqual([record(1), record(2)]);
  });

  test("migrate copies local records once and is idempotent", async () => {
    const { db, storage, root, objects, store } = await setup(backend);
    writeLocal(root, 1);
    writeLocal(root, 1, "quality/lint");
    writeFileSync(join(root, "retry.lock"), "");
    expect(await migrateCloseoutEvidence(db, storage)).toEqual({ copied: 2, skipped: 0 });
    expect(await migrateCloseoutEvidence(db, storage)).toEqual({ copied: 0, skipped: 2 });
    expect((await objects!.list()).sort()).toEqual([
      `evidence/${HEX}/${HEAD}/quality/lint/1.json`,
      `evidence/${HEX}/${HEAD}/quality/test/1.json`,
    ]);
    const only = createEvidenceStore({ root: join(storage.root, "elsewhere"), objects: null });
    expect(await only.load()).toEqual({ records: [] });
    expect((await store.load()).records).toEqual([record(1, "quality/lint"), record(1)]);
  });
});

test("a root outside the Closeout evidence directory stays on disk", async () => {
  const { db, storage } = await setup(() => createFakeRunFileObjects());
  expect(closeoutRecordObjects(db, storage)(join(tempHome(), "repo", ".closeout"))).toBeNull();
  expect(closeoutRecordObjects(db, { root: storage.root })(join(storage.root, "task"))).toBeNull();
});
