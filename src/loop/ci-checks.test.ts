import { afterEach, expect, test } from "bun:test";
import type { RerunCommand, RerunPolicy, TurnPass } from "../closeout";
import { fixRecordSteps, getWorkItem, recordPullCiFailureSteps, type Db } from "../db";
import { insertWorkItem } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import { ciCarried, ciChecksFor, type CiChecks } from "./ci-checks";
import { closeoutFocus } from "./closeout-focus";
import { createDbCloseoutProgress } from "./closeout-progress";

const ITEM = "ENG-1";
const FAILED = "f".repeat(40);
const HEAD = "c".repeat(40);
const COMMANDS: RerunCommand[] = [
  { id: "lint", ci: "lint, format, types, test, dashboard build" },
  { id: "test", ci: "test (*)", since: ["bun", "scripts/test-since.ts", "{since}"] },
  { id: "knip" },
  { id: "proof", paths: ["src/loop/**"] },
];
const policy = (run: "all" | "failed" | null, digest = "policy") => ({
  digest,
  ...(run ? { rerun: { ci: { run } } as RerunPolicy } : {}),
  commands: COMMANDS,
});

type Setup = {
  failed?: string[] | null;
  record?: boolean;
  decision?: "accepted" | "rejected";
  finished?: boolean;
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(input: Setup = {}): Promise<Db> {
  const store = await tempStore();
  close = store.close;
  const { db } = store;
  await insertWorkItem(db, ITEM);
  const item = (await getWorkItem(db, ITEM))!;
  if (input.record !== false)
    await db.run((q) =>
      fixRecordSteps(q, item, {
        reason: "ci",
        triggers: { checks: [{ name: "test (ubuntu)", url: null }] },
        headBefore: FAILED,
        now: 1,
      }),
    );
  if (input.failed !== null)
    await db.run((q) =>
      recordPullCiFailureSteps(
        q,
        {
          itemId: ITEM,
          head: FAILED,
          pullNumber: 7,
          itemVersion: 1,
          failedChecks: (input.failed ?? ["test (ubuntu)"]).map((name) => ({ name, url: null })),
          checks: [],
          observedAt: 2,
        },
        { quietMs: 60, maxMs: 300 },
      ),
    );
  const identity = {
    taskId: ITEM,
    head: FAILED,
    base: "b".repeat(40),
    policyDigest: "policy",
    policyPath: null,
  };
  const progress = createDbCloseoutProgress(db, ITEM, () => 10);
  await progress.begin(identity);
  const ids = ["lint", "test", "knip", "proof", "independent-review"];
  for (const [ordinal, id] of ids.entries())
    await progress.step(identity, {
      id,
      kind: id === "independent-review" ? "review" : "command",
      state: "passed",
      command: id,
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath: null,
      findings: null,
      ordinal,
    });
  if (input.finished !== false) await progress.finish(identity, input.decision ?? "accepted");
  return db;
}

const read = (db: Db, over: Partial<Parameters<typeof ciChecksFor>[1]> = {}) =>
  ciChecksFor(db, { itemId: ITEM, reason: "ci", policy: policy("failed"), ...over });

test("a CI fix with run: failed runs the matched check since the failed head and keeps the rest", async () => {
  const db = await setup();
  const ci = await read(db);
  expect(ci).toEqual({
    head: FAILED,
    policyDigest: "policy",
    failed: ["test (ubuntu)"],
    since: ["test"],
    passed: ["lint", "knip", "proof"],
  });
  expect(await closeoutFocus(db, ITEM, "ci", undefined, ci)).toEqual({
    scope: "changed",
    head: FAILED,
    policyDigest: "policy",
    passed: ["lint", "knip", "proof"],
    since: ["test"],
  });
});

test("a matched check without since runs its exec", async () => {
  const db = await setup({ failed: ["lint, format, types, test, dashboard build"] });
  expect(await read(db)).toMatchObject({ since: [], passed: ["test", "knip", "proof"] });
});

test("the whole plan runs when any condition fails", async () => {
  const db = await setup();
  expect(await read(db, { policy: policy("all") })).toBeUndefined();
  expect(await read(db, { policy: policy(null) })).toBeUndefined();
  expect(await read(db, { policy: policy("failed", "changed") })).toBeUndefined();
  expect(await read(db, { policy: null })).toBeUndefined();
  expect(await read(db, { reason: "findings" })).toBeUndefined();
  await close?.();
  expect(await read(await setup({ failed: ["test (ubuntu)", "deploy"] }))).toBeUndefined();
  await close?.();
  expect(await read(await setup({ failed: null }))).toBeUndefined();
  await close?.();
  expect(await read(await setup({ record: false }))).toBeUndefined();
  await close?.();
  expect(await read(await setup({ decision: "rejected" }))).toBeUndefined();
  await close?.();
  expect(await read(await setup({ finished: false }))).toBeUndefined();
});

const CI: CiChecks = {
  head: FAILED,
  policyDigest: "policy",
  failed: ["test (ubuntu)"],
  since: ["test"],
  passed: ["lint", "knip", "proof"],
};
const pass = (policyDigest = "policy"): TurnPass => ({
  id: "test",
  command: `bun scripts/test-since.ts ${FAILED}`,
  head: HEAD,
  base: "b".repeat(40),
  policyDigest,
  at: 1,
  durationMs: 1,
  stdout: "",
  stderr: "",
  truncated: false,
});

test("passed checks whose paths did not change since the failed head are carried", () => {
  expect(
    ciCarried(CI, { head: HEAD, commands: COMMANDS, fromTurn: [pass()], changed: ["docs/a.md"] }),
  ).toEqual([{ id: "proof", head: FAILED }]);
  expect(
    ciCarried(CI, { head: HEAD, commands: COMMANDS, fromTurn: [pass()], changed: [] }),
  ).toEqual(["lint", "knip", "proof"].map((id) => ({ id, head: FAILED })));
});

test("nothing is carried without turn passes at the policy digest or a readable diff", () => {
  const input = { head: HEAD, commands: COMMANDS, changed: [] };
  expect(ciCarried(CI, { ...input, fromTurn: [] })).toBeUndefined();
  expect(ciCarried(CI, { ...input, fromTurn: [pass("other")] })).toBeUndefined();
  expect(ciCarried(CI, { ...input, fromTurn: [pass()], changed: null })).toBeUndefined();
});
