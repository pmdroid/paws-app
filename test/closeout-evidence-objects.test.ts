import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { handleStatusRequest, itemReviews } from "../src/dashboard";
import { finishCloseoutProgress, insertQueuedItem, upsertCloseoutStep } from "../src/db";
import {
  hydrateCloseoutEvidence,
  hydrateItemCloseoutEvidence,
  publishCloseoutEvidence,
  uploadLocalCloseoutEvidence,
} from "../src/evidence";
import { createFakeRunFileObjects, withSealedRunFileObjects } from "../src/run-files";
import { tempDb, tempHome } from "./helpers";

const ITEM = "item-acme";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const HEX = "ef".repeat(32);
const DIGEST = `sha256:${HEX}`;
const RECORD = `evidence/${HEX}/${HEAD}/independent-review/1.json`;
const LOG = `logs/${HEX}/${HEAD}/test/1.log`;

function closeoutRun(db: Database, home: string): string {
  const root = join(home, "closeout", "evidence");
  const write = (path: string, body: string) => {
    const file = join(root, ITEM, ...path.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  };
  write(
    RECORD,
    JSON.stringify({
      recordType: "review",
      itemId: "independent-review",
      base: BASE,
      head: HEAD,
      attempt: 1,
      findings: [
        { severity: "P1", location: "src/acme.ts:1", explanation: "acme breaks", evidence: "e" },
      ],
    }),
  );
  write(LOG, "acme test output\n");
  write("retry.lock", "");
  const identity = { taskId: ITEM, base: BASE, head: HEAD, policyDigest: DIGEST, policyPath: null };
  upsertCloseoutStep(
    db,
    ITEM,
    identity,
    {
      id: "independent-review",
      kind: "review",
      state: "failed",
      command: "",
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: 1,
      finishedAt: 1,
      exitCode: null,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: RECORD,
      findings: null,
      ordinal: 0,
      failOn: "P1",
      preExisting: [],
    },
    1,
  );
  finishCloseoutProgress(db, ITEM, identity, "rejected", 1);
  return root;
}

function setup() {
  const db = tempDb();
  insertQueuedItem(db, { id: ITEM, sessionKey: "session-acme", now: 1 });
  const s3 = createFakeRunFileObjects();
  const objects = () => withSealedRunFileObjects(s3, Buffer.alloc(32, 9));
  const homeA = tempHome();
  const homeB = tempHome();
  const storageA = { root: closeoutRun(db, homeA), objects };
  const storageB = { root: join(homeB, "closeout", "evidence"), objects };
  return { db, s3, objects, homeA, homeB, storageA, storageB };
}

test("Closeout records written by instance A are shown by instance B's dashboard", async () => {
  const { db, s3, homeB, storageA, storageB } = setup();
  expect(await publishCloseoutEvidence(db, storageA, ITEM)).toBe(2);
  expect([...s3.objects.keys()].every((key) => key.startsWith(`closeout-evidence/${ITEM}/`))).toBe(
    true,
  );
  expect(await publishCloseoutEvidence(db, storageA, ITEM)).toBe(0);

  expect(itemReviews(db, ITEM, homeB, {})).toEqual([]);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM, ["session-acme"])).toBe(2);
  const reviews = itemReviews(db, ITEM, homeB, {});
  expect(reviews.map((review) => review.id)).toEqual(["independent-review"]);
  expect(reviews[0]!.rounds[0]!.findings[0]).toMatchObject({ explanation: "acme breaks" });

  const artifact = await handleStatusRequest(
    new Request(
      `http://acme.test/api/closeout-artifact?item=${ITEM}&check=independent-review&kind=evidence&head=${HEAD}&policy=${DIGEST}`,
    ),
    { db, closeoutHome: homeB },
  );
  expect(artifact!.status).toBe(200);
  expect(await artifact!.text()).toContain("acme breaks");
  expect(existsSync(join(storageB.root, ITEM, "retry.lock"))).toBe(false);
});

test("an item the session can't see is not restored", async () => {
  const { db, storageA, storageB } = setup();
  await publishCloseoutEvidence(db, storageA, ITEM);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM, ["session-other"])).toBe(0);
  expect(existsSync(join(storageB.root, ITEM))).toBe(false);
});

test("a changed object is not restored, and a changed local file replaces its copy", async () => {
  const { db, s3, storageA, storageB } = setup();
  await publishCloseoutEvidence(db, storageA, ITEM);
  const [first, second] = [...s3.objects.keys()];
  const original = s3.objects.get(first!)!;
  s3.objects.set(first!, s3.objects.get(second!)!);
  expect(await hydrateCloseoutEvidence(db, storageB, [ITEM])).toBe(1);
  s3.objects.set(first!, original);

  writeFileSync(join(storageA.root, ITEM, ...LOG.split("/")), "acme test output, again\n");
  expect(await publishCloseoutEvidence(db, storageA, ITEM)).toBe(1);
  expect(s3.deletes.length).toBe(1);
  const storageC = { ...storageB, root: join(tempHome(), "closeout", "evidence") };
  expect(await hydrateCloseoutEvidence(db, storageC, [ITEM])).toBe(2);
  expect(readFileSync(join(storageC.root, ITEM, ...LOG.split("/")), "utf8")).toBe(
    "acme test output, again\n",
  );
});

test("with S3 off, Closeout records stay local", async () => {
  const { db, s3, storageA, storageB } = setup();
  expect(await publishCloseoutEvidence(db, { root: storageA.root }, ITEM)).toBe(0);
  expect(await uploadLocalCloseoutEvidence(db, { root: storageA.root })).toBe(0);
  expect(await hydrateCloseoutEvidence(db, { root: storageB.root }, [ITEM])).toBe(0);
  expect(s3.writes).toEqual([]);
  expect(existsSync(join(storageA.root, ITEM, ...RECORD.split("/")))).toBe(true);
});

test("existing Closeout records are uploaded once on startup and read from S3 afterwards", async () => {
  const { db, homeB, storageA, storageB } = setup();
  expect(await uploadLocalCloseoutEvidence(db, storageA)).toBe(2);
  expect(await uploadLocalCloseoutEvidence(db, storageA)).toBe(0);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM)).toBe(2);
  expect(itemReviews(db, ITEM, homeB, {})).toHaveLength(1);
});
