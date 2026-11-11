import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { handleStatusRequest, itemReviews } from "../src/dashboard";
import { finishCloseoutProgress, insertQueuedItem, upsertCloseoutStep, sqliteDb } from "../src/db";
import {
  hydrateCloseoutEvidence,
  hydrateItemCloseoutEvidence,
  publishCloseoutEvidence,
  uploadLocalCloseoutEvidence,
} from "../src/evidence";
import { publishingCloseoutProgress } from "../src/loop";
import { createFakeRunFileObjects, withSealedRunFileObjects } from "../src/run-files";
import { tempDb, tempHome } from "./helpers";

const ITEM = "item-acme";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const HEX = "ef".repeat(32);
const DIGEST = `sha256:${HEX}`;
const RECORD = `evidence/${HEX}/${HEAD}/independent-review/1.json`;
const LOG = `logs/${HEX}/${HEAD}/test/1.log`;

async function closeoutRun(db: Database, home: string, item = ITEM): Promise<string> {
  const root = join(home, "closeout", "evidence");
  const write = (path: string, body: string) => {
    const file = join(root, item, ...path.split("/"));
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
  const identity = { taskId: item, base: BASE, head: HEAD, policyDigest: DIGEST, policyPath: null };
  await upsertCloseoutStep(
    sqliteDb(db),
    item,
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
  await finishCloseoutProgress(sqliteDb(db), item, identity, "rejected", 1);
  return root;
}

async function setup() {
  const db = tempDb();
  insertQueuedItem(db, { id: ITEM, sessionKey: "session-acme", now: 1 });
  const s3 = createFakeRunFileObjects();
  const objects = () => withSealedRunFileObjects(s3, Buffer.alloc(32, 9));
  const homeA = tempHome();
  const homeB = tempHome();
  const storageA = { root: await closeoutRun(db, homeA), objects };
  const storageB = { root: join(homeB, "closeout", "evidence"), objects };
  return { db, s3, objects, homeA, homeB, storageA, storageB };
}

test("Closeout records written by instance A are shown by instance B's dashboard", async () => {
  const { db, s3, homeB, storageA, storageB } = await setup();
  expect(await publishCloseoutEvidence(db, storageA, ITEM)).toBe(2);
  expect([...s3.objects.keys()].every((key) => key.startsWith(`closeout-evidence/${ITEM}/`))).toBe(
    true,
  );
  expect(await publishCloseoutEvidence(db, storageA, ITEM)).toBe(0);

  expect(await itemReviews(db, ITEM, homeB, {})).toEqual([]);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM, ["session-acme"])).toBe(2);
  const reviews = await itemReviews(db, ITEM, homeB, {});
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
  const { db, storageA, storageB } = await setup();
  await publishCloseoutEvidence(db, storageA, ITEM);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM, ["session-other"])).toBe(0);
  expect(existsSync(join(storageB.root, ITEM))).toBe(false);
});

test("a changed object is not restored, and a changed local file replaces its copy", async () => {
  const { db, s3, storageA, storageB } = await setup();
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
  const { db, s3, storageA, storageB } = await setup();
  expect(await publishCloseoutEvidence(db, { root: storageA.root }, ITEM)).toBe(0);
  expect(await uploadLocalCloseoutEvidence(db, { root: storageA.root })).toBe(0);
  expect(await hydrateCloseoutEvidence(db, { root: storageB.root }, [ITEM])).toBe(0);
  expect(s3.writes).toEqual([]);
  expect(existsSync(join(storageA.root, ITEM, ...RECORD.split("/")))).toBe(true);
});

test("existing Closeout records are uploaded once on startup and read from S3 afterwards", async () => {
  const { db, homeB, storageA, storageB } = await setup();
  expect(await uploadLocalCloseoutEvidence(db, storageA)).toBe(2);
  expect(await uploadLocalCloseoutEvidence(db, storageA)).toBe(0);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM)).toBe(2);
  expect(await itemReviews(db, ITEM, homeB, {})).toHaveLength(1);
});

test("a finished check's files are stored before its step is recorded, while the gate still runs", async () => {
  const { db, homeB, storageA, storageB } = await setup();
  const calls: string[] = [];
  const progress = publishingCloseoutProgress(
    {
      begin: () => calls.push("begin"),
      step: (_identity, step) => calls.push(`step ${step.state}`),
      output: () => calls.push("output"),
      finish: () => calls.push("finish"),
    },
    async () => {
      calls.push("publish");
      await publishCloseoutEvidence(db, storageA, ITEM);
    },
  );
  const identity = { taskId: ITEM, base: BASE, head: HEAD, policyDigest: DIGEST, policyPath: null };
  const step = (state: "running" | "passed") => ({
    id: "independent-review",
    kind: "review" as const,
    state,
    command: "",
    detail: null,
    attempt: 1,
    timeoutSeconds: null,
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: null,
    evidencePath: RECORD,
    findings: null,
    ordinal: 0,
  });
  progress.begin(identity);
  progress.step(identity, step("running"));
  progress.output(identity, "independent-review", "stdout", "acme", false);
  progress.step(identity, step("passed"));
  await progress.settled();
  expect(calls).toEqual(["begin", "step running", "output", "publish", "step passed"]);
  expect(await hydrateItemCloseoutEvidence(db, storageB, ITEM)).toBe(2);
  expect(await itemReviews(db, ITEM, homeB, {})).toHaveLength(1);
});

test("a failed step write is raised once the queued steps settle", async () => {
  const progress = publishingCloseoutProgress(
    {
      begin: () => {
        throw new Error("acme database busy");
      },
      step: () => {},
      output: () => {},
      finish: () => {},
    },
    async () => {},
  );
  progress.begin({ taskId: ITEM, base: BASE, head: HEAD, policyDigest: DIGEST, policyPath: null });
  expect(progress.settled()).rejects.toThrow("acme database busy");
});

test("restored records keep their modification times, and a newer stored copy replaces an older one", async () => {
  const { db, storageA, storageB } = await setup();
  const record = join(storageA.root, ITEM, ...RECORD.split("/"));
  utimesSync(record, 1_700_000_000, 1_700_000_000);
  await publishCloseoutEvidence(db, storageA, ITEM);
  await hydrateCloseoutEvidence(db, storageB, [ITEM]);
  const restored = join(storageB.root, ITEM, ...RECORD.split("/"));
  expect(Math.floor(statSync(restored).mtimeMs)).toBe(1_700_000_000_000);

  const log = join(storageA.root, ITEM, ...LOG.split("/"));
  await Bun.sleep(5);
  writeFileSync(log, "acme partial\nacme done\n");
  expect(await publishCloseoutEvidence(db, storageA, ITEM)).toBe(1);
  expect(await hydrateCloseoutEvidence(db, storageB, [ITEM])).toBe(1);
  expect(readFileSync(join(storageB.root, ITEM, ...LOG.split("/")), "utf8")).toBe(
    "acme partial\nacme done\n",
  );
  expect(await hydrateCloseoutEvidence(db, storageA, [ITEM])).toBe(0);
  await Bun.sleep(5);
  writeFileSync(log, "acme unpublished\n");
  expect(await hydrateCloseoutEvidence(db, storageA, [ITEM])).toBe(1);
  expect(readFileSync(log, "utf8")).toBe("acme partial\nacme done\n");
});

test("every visible item with the issue's identifier has its Closeout records restored", async () => {
  const { db, homeA, storageA, storageB } = await setup();
  insertQueuedItem(db, { id: "item-acme-2", sessionKey: "session-acme", now: 1 });
  insertQueuedItem(db, { id: "item-acme-3", sessionKey: "session-other", now: 1 });
  db.run("UPDATE work_item SET linear_identifier = 'ACME-1'");
  await closeoutRun(db, homeA, "item-acme-2");
  await closeoutRun(db, homeA, "item-acme-3");
  await uploadLocalCloseoutEvidence(db, storageA);
  expect(await hydrateItemCloseoutEvidence(db, storageB, "ACME-1", ["session-acme"])).toBe(4);
  expect(existsSync(join(storageB.root, "item-acme-2", ...RECORD.split("/")))).toBe(true);
  expect(existsSync(join(storageB.root, "item-acme-3"))).toBe(false);
});

test("a check whose evidence can't be stored is recorded as failed, never as passed", async () => {
  const identity = { taskId: ITEM, base: BASE, head: HEAD, policyDigest: DIGEST, policyPath: null };
  const recorded = (publish: () => Promise<void>) => {
    const calls: string[] = [];
    const progress = publishingCloseoutProgress(
      {
        begin: () => {},
        step: (_identity, step) => calls.push(`step ${step.state} ${step.detail ?? ""}`.trim()),
        output: () => {},
        finish: (_identity, decision) => calls.push(`finish ${decision}`),
      },
      publish,
    );
    progress.step(identity, {
      id: "test",
      kind: "command",
      state: "passed",
      command: "bun test",
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: LOG,
      evidencePath: null,
      findings: null,
      ordinal: 0,
    });
    progress.finish(identity, "accepted");
    return { calls, progress };
  };

  const broken = recorded(async () => {
    throw new Error("acme bucket unavailable");
  });
  await expect(broken.progress.settled()).rejects.toThrow("acme bucket unavailable");
  expect(broken.calls).toEqual([
    "step failed Paws could not store this check's evidence in the object store.",
    "finish blocked",
  ]);

  let failures = 1;
  const flaky = recorded(async () => {
    if (failures-- > 0) throw new Error("acme bucket hiccup");
  });
  await flaky.progress.settled();
  expect(flaky.calls).toEqual(["step passed", "finish accepted"]);
});

test("the startup upload keeps a path already in the store instead of replacing it", async () => {
  const { db, storageA, storageB } = await setup();
  await publishCloseoutEvidence(db, storageA, ITEM);
  await Bun.sleep(5);
  writeFileSync(join(storageA.root, ITEM, ...LOG.split("/")), "acme stale local copy\n");
  expect(await uploadLocalCloseoutEvidence(db, storageA)).toBe(0);
  await hydrateCloseoutEvidence(db, storageB, [ITEM]);
  expect(readFileSync(join(storageB.root, ITEM, ...LOG.split("/")), "utf8")).toBe(
    "acme test output\n",
  );
  expect(await hydrateCloseoutEvidence(db, storageA, [ITEM], { strict: true })).toBe(1);
  expect(readFileSync(join(storageA.root, ITEM, ...LOG.split("/")), "utf8")).toBe(
    "acme test output\n",
  );
});

test("a startup upload that loses to a concurrent publish keeps the published copy", async () => {
  const { db, s3, objects, homeB, storageA, storageB } = await setup();
  const publisher = { root: await closeoutRun(db, homeB), objects };
  writeFileSync(join(publisher.root, ITEM, ...LOG.split("/")), "acme published meanwhile\n");
  let raced = false;
  const racing = () => {
    const sealed = objects();
    return {
      ...sealed,
      async write(key: string, bytes: Uint8Array) {
        if (!raced) {
          raced = true;
          await publishCloseoutEvidence(db, publisher, ITEM);
        }
        await sealed.write(key, bytes);
      },
    };
  };
  await uploadLocalCloseoutEvidence(db, { root: storageA.root, objects: racing });
  const storageC = { ...storageB, root: join(tempHome(), "closeout", "evidence") };
  await hydrateCloseoutEvidence(db, storageC, [ITEM], { strict: true });
  expect(readFileSync(join(storageC.root, ITEM, ...LOG.split("/")), "utf8")).toBe(
    "acme published meanwhile\n",
  );
  const prefixes = new Set([...s3.objects.keys()].map((key) => key.replace(/\/\d+$/, "")));
  expect(prefixes.size).toBe(2);
});

test("a restore that started before a file was replaced reads the replacement", async () => {
  const { db, objects, storageA, storageB } = await setup();
  await publishCloseoutEvidence(db, storageA, ITEM);
  await Bun.sleep(5);
  writeFileSync(join(storageA.root, ITEM, ...LOG.split("/")), "acme replaced\n");
  let replaced = false;
  const racing = () => {
    const sealed = objects();
    return {
      ...sealed,
      async read(key: string) {
        if (!replaced) {
          replaced = true;
          await publishCloseoutEvidence(db, storageA, ITEM);
        }
        return sealed.read(key);
      },
    };
  };
  expect(
    await hydrateCloseoutEvidence(db, { root: storageB.root, objects: racing }, [ITEM], {
      strict: true,
    }),
  ).toBe(2);
  expect(readFileSync(join(storageB.root, ITEM, ...LOG.split("/")), "utf8")).toBe(
    "acme replaced\n",
  );
});

test("a strict restore fails when a file can't be restored; a lenient one carries on", async () => {
  const { db, s3, storageA, storageB } = await setup();
  await publishCloseoutEvidence(db, storageA, ITEM);
  const [first] = [...s3.objects.keys()];
  s3.objects.set(first!, new Uint8Array(64));
  await expect(hydrateCloseoutEvidence(db, storageB, [ITEM], { strict: true })).rejects.toThrow();
  const storageC = { ...storageB, root: join(tempHome(), "closeout", "evidence") };
  expect(await hydrateCloseoutEvidence(db, storageC, [ITEM])).toBe(1);
});
