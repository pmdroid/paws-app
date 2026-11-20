import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { CiResult, TurnPass } from "../closeout";
import type { MergeSettings } from "../config";
import { JOB_KIND } from "../core";
import {
  enqueueJob,
  fixRecordSteps,
  getWorkItem,
  keepTaskMergeSettings,
  recordRebaseReturn,
  saveCandidateRiskSteps,
  type Db,
  type FixTriggers,
  type RebaseReturn,
} from "../db";
import { insertWorkItem } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import { createDbCloseoutProgress } from "./closeout-progress";
import { conflictCarried, conflictChecksFor, type ConflictChecks } from "./conflict-checks";

const ITEM = "ENG-1";
const ACCEPTED = "a".repeat(40);
const settings = (ids: string[]): MergeSettings =>
  ({ repositories: { "acme/widgets": { conflictChecks: ids } } }) as unknown as MergeSettings;

type Setup = {
  triggers?: FixTriggers;
  records?: number;
  reason?: RebaseReturn["reason"];
  headBefore?: string;
  decision?: "accepted" | "rejected";
  finished?: boolean;
  tier?: "normal" | "high" | null;
  mainMoved?: "ci" | "closeout" | null;
  steps?: { id: string; kind: "command" | "review"; state: "passed" | "failed" }[];
};

const STEPS: Setup["steps"] = [
  { id: "lint", kind: "command", state: "passed" },
  { id: "typecheck", kind: "command", state: "passed" },
  { id: "test", kind: "command", state: "passed" },
  { id: "proof", kind: "command", state: "passed" },
  { id: "independent-review", kind: "review", state: "passed" },
];

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
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.workItem)
        .set({ acceptedHead: ACCEPTED, state: "running" })
        .where(eq(q.t.workItem.id, ITEM)),
    ),
  );
  const item = (await getWorkItem(db, ITEM))!;
  for (let n = 0; n < (input.records ?? 1); n++)
    await db.run((q) =>
      fixRecordSteps(q, item, {
        reason: "conflict",
        triggers: input.triggers ?? { base: `main-${n}` },
        headBefore: input.headBefore ?? ACCEPTED,
        now: n,
      }),
    );
  const jobId = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: ITEM, reason: "conflict" },
    now: 1,
  });
  await recordRebaseReturn(db, {
    itemId: ITEM,
    jobId,
    candidate: ACCEPTED,
    reason: input.reason ?? "github_queue",
  });
  const identity = {
    taskId: ITEM,
    head: ACCEPTED,
    base: "b".repeat(40),
    policyDigest: "policy",
    policyPath: null,
  };
  const progress = createDbCloseoutProgress(db, ITEM, () => 10);
  await progress.begin(identity);
  for (const [ordinal, step] of (input.steps ?? STEPS)!.entries())
    await progress.step(identity, {
      ...step,
      command: step.id,
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
  if (input.tier !== null)
    await db.run((q) =>
      saveCandidateRiskSteps(q, {
        itemId: ITEM,
        head: ACCEPTED,
        base: "b".repeat(40),
        tier: input.tier ?? "normal",
        paths: [],
        classifiedAt: 1,
      }),
    );
  if (input.mainMoved !== null)
    await keepTaskMergeSettings(
      db,
      ITEM,
      { order: "queue", mainMoved: input.mainMoved ?? "ci", resolved: {} },
      1,
    );
  return db;
}

const read = (db: Db, over: Partial<Parameters<typeof conflictChecksFor>[1]> = {}) =>
  conflictChecksFor(db, {
    itemId: ITEM,
    reason: "conflict",
    settings: settings(["lint", "typecheck"]),
    repository: "Acme/Widgets",
    briefs: false,
    ...over,
  });

test("a merge-queue conflict of an accepted normal-risk head runs the listed checks and carries the rest", async () => {
  expect(await read(await setup())).toEqual({
    head: ACCEPTED,
    policyDigest: "policy",
    run: ["lint", "typecheck"],
    carried: ["test", "proof"],
  });
});

const refused: [string, Setup, Partial<Parameters<typeof conflictChecksFor>[1]>][] = [
  ["the repository lists no checks", {}, { settings: settings([]) }],
  ["the restart is not a conflict", {}, { reason: "ci" }],
  ["two fix records are open", { records: 2 }, {}],
  [
    "the fix record folded in a CI failure",
    { triggers: { base: "m", checks: [{ name: "ci", url: null }] } },
    {},
  ],
  ["the fix record has no base", { triggers: {} }, {}],
  ["the latest return is a push conflict", { reason: "push" }, {}],
  ["the handoff carries a comment or suggestion brief", {}, { briefs: true }],
  ["the fix started from another head", { headBefore: "c".repeat(40) }, {}],
  ["the accepted head's run was rejected", { decision: "rejected" }, {}],
  ["the accepted head's run is unfinished", { finished: false }, {}],
  ["the accepted head has no risk row", { tier: null }, {}],
  ["the accepted head is high risk", { tier: "high" }, {}],
  ["the task merges with main_moved closeout", { mainMoved: "closeout" }, {}],
  ["the task has no kept merge settings", { mainMoved: null }, {}],
  ["a listed id is not a step of the run", {}, { settings: settings(["lint", "format"]) }],
];
for (const [name, input, over] of refused)
  test(`nothing is returned when ${name}`, async () => {
    expect(await read(await setup(input), over)).toBeUndefined();
  });

const conflict: ConflictChecks = {
  head: ACCEPTED,
  policyDigest: "policy",
  run: ["lint"],
  carried: ["proof"],
};
const NEW = "d".repeat(40);
const pass = (head: string, policyDigest = "policy"): TurnPass => ({
  id: "lint",
  command: "lint",
  head,
  base: "b",
  policyDigest,
  at: 1,
  durationMs: 1,
  stdout: "",
  stderr: "",
  truncated: false,
});
const green = [{ id: "test" }] as unknown as CiResult[];
const carriedInput = {
  head: NEW,
  fromCi: green,
  fromTurn: [pass(NEW)],
  paths: ["a.ts"],
  acceptedPaths: ["a.ts", "b.ts"],
};

test("green CI, a turn pass at the new head and no new path carry the passes", () => {
  expect(conflictCarried(conflict, carriedInput)).toEqual([{ id: "proof", head: ACCEPTED }]);
});

for (const [name, over] of [
  ["CI is not green", { fromCi: [] as CiResult[] }],
  ["the new head changes one more path", { paths: ["a.ts", "c.ts"] }],
  ["the new head's paths are unreadable", { paths: null }],
  ["the turn has no pass at the new head", { fromTurn: [pass(ACCEPTED)] }],
  ["a pass has another policy digest", { fromTurn: [pass(NEW), pass(NEW, "other")] }],
] as const)
  test(`nothing is carried when ${name}`, () => {
    expect(conflictCarried(conflict, { ...carriedInput, ...over })).toBeUndefined();
  });
