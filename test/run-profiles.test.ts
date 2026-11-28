import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  getRunProfileSteps,
  getWorkItem,
  insertQueuedItem,
  keepRunProfileSteps,
  type Db,
  type WorkItemRecord,
} from "../src/db";
import { runDir } from "../src/acp";
import { useMemorySettings, writeAgentSettings } from "../src/config";
import { Orchestrator, moveRunProfileFiles } from "../src/loop";
import { tempStore } from "./pglite";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const first = {
  implementer: { agent: "claude", model: "first" },
  reviewer: { agent: "codex", model: "review" },
} as const;
const changed = {
  implementer: { agent: "codex", model: "changed" },
  reviewer: { agent: "claude", model: "other" },
} as const;
const candidate = { session: "s-1", model: "first", provider: "anthropic" };

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  cleanups.push(close);
  return db;
}

function home(): string {
  const root = tempHome();
  const settings = useMemorySettings(root);
  cleanups.push(() => {
    settings.release();
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function runFor(db: Db, id: string) {
  const queued = await insertQueuedItem(db, { id, now: 1000 });
  return (await beginImplementRun(db, queued.id, 1000)).run;
}

function legacyFile(root: string, runId: string, record: unknown): string {
  mkdirSync(runDir(root, runId), { recursive: true });
  const file = join(runDir(root, runId), "agent-profile.json");
  writeFileSync(file, JSON.stringify(record));
  return file;
}

const profileOf = (db: Db, runId: string) => db.run((q) => getRunProfileSteps(q, runId));

type Internals = {
  ensureRun(item: WorkItemRecord): Promise<{ id: string }>;
  saveCandidate(runId: string, candidate: unknown): Promise<void>;
  profileSnapshot(runId: string): Promise<unknown>;
  candidateFor(runId: string): Promise<unknown>;
};

function worker(db: Db, root: string): Internals {
  const clock = new FakeClock(1000);
  return new Orchestrator({
    store: db,
    pawsRoot: root,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
  }) as unknown as Internals;
}

test("a second worker with a fresh home recovers the saved identity after the defaults changed", async () => {
  const db = await store();
  const [one, two] = [home(), home()];
  await writeAgentSettings(one, { defaults: first });
  await writeAgentSettings(two, { defaults: changed });
  const queued = await insertQueuedItem(db, { id: "item-1", now: 1000 });
  const a = worker(db, one);
  const run = await a.ensureRun((await getWorkItem(db, queued.id))!);
  await a.saveCandidate(run.id, candidate);
  const b = worker(db, two);
  expect(await b.profileSnapshot(run.id)).toEqual(first);
  expect(await b.candidateFor(run.id)).toEqual(candidate);
  expect(existsSync(join(runDir(two, run.id), "agent-profile.json"))).toBe(false);
});

test("a legacy snapshot moves into the database as written, settings changes included", async () => {
  const db = await store();
  const root = home();
  await writeAgentSettings(root, { defaults: first });
  const run = await runFor(db, "item-1");
  const saved = {
    profiles: changed,
    candidate,
    settingsSwitch: { id: "switch", previousAgent: "claude" },
  };
  const file = legacyFile(root, run.id, saved);
  legacyFile(root, "01UNKNOWNRUN", saved);
  expect(await moveRunProfileFiles(db, root)).toBe(1);
  expect(await profileOf(db, run.id)).toEqual(saved);
  expect(existsSync(file)).toBe(false);
  expect(await worker(db, root).profileSnapshot(run.id)).toEqual(changed);
  expect(await moveRunProfileFiles(db, root)).toBe(0);
});

test("an interrupted migration completes on retry and keeps rows already moved", async () => {
  const db = await store();
  const root = home();
  const runs = [await runFor(db, "item-1"), await runFor(db, "item-2")];
  const files = runs.map((run) => legacyFile(root, run.id, { profiles: first, candidate }));
  let calls = 0;
  const crashing = Object.create(db, {
    transaction: {
      value: (...args: Parameters<Db["transaction"]>) => {
        if (++calls > 1) throw new Error("killed");
        return db.transaction(...args);
      },
    },
  }) as Db;
  await expect(moveRunProfileFiles(crashing, root)).rejects.toThrow("killed");
  const moved = runs.findIndex(
    (run) => !existsSync(join(runDir(root, run.id), "agent-profile.json")),
  );
  expect(moved).toBeGreaterThanOrEqual(0);
  const left = runs[1 - moved]!;
  expect(await profileOf(db, left.id)).toBeNull();
  writeFileSync(files[moved]!, JSON.stringify({ profiles: changed }));
  expect(await moveRunProfileFiles(db, root)).toBe(2);
  expect(await profileOf(db, runs[moved]!.id)).toEqual({ profiles: first, candidate });
  expect(await profileOf(db, left.id)).toEqual({ profiles: first, candidate });
  expect(files.some((file) => existsSync(file))).toBe(false);
});

test("concurrent writers keep one profile row per run", async () => {
  const db = await store();
  const run = await runFor(db, "item-1");
  const kept = await Promise.all(
    [first, changed, first].map((profiles, index) =>
      db.transaction((q) => keepRunProfileSteps(q, run.id, { profiles }, index)),
    ),
  );
  expect(new Set(kept.map((row) => JSON.stringify(row))).size).toBe(1);
  expect(await profileOf(db, run.id)).toEqual(kept[0]!);
});
