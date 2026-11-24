import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pawsPaths } from "../src/config";
import type { Q } from "../src/db";
import type { RunnerCommand, RunnerStorageCleanupResult } from "../src/runner-protocol";
import { handleStorageCleanupRequest } from "../src/settings";
import { createRunnerStorageCleaner, createStorageCleanup } from "../src/storage-cleanup";
import { describePglite, seed } from "./pglite-fixtures";
import { NOW, workspaceWithRunners } from "./runner-slot-fixture";

const DAY = 86_400_000;
const FINISHED = "01KAAAAAAAAAAAAAAAAAAAAAAA";
const RECENT = "01KBBBBBBBBBBBBBBBBBBBBBBB";
const RUNNING = "01KCCCCCCCCCCCCCCCCCCCCCCC";
const UNKNOWN = "01KDDDDDDDDDDDDDDDDDDDDDDD";
const ABANDONED = "01KEEEEEEEEEEEEEEEEEEEEEEE";
const HEALTH = "01KFFFFFFFFFFFFFFFFFFFFFFF";
let root: string;
const closers: (() => unknown)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-runner-cleanup-"));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(root, { recursive: true, force: true });
});

function log(path: string, ageDays: number, now: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(8192, 1));
  const seconds = (now - ageDays * DAY) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

function runnerHome(now: number) {
  const home = join(root, "runner");
  const runtime = join(home, "runtime", "workers");
  const health = join(home, "health", "workers");
  const files = {
    finished: log(join(runtime, `${FINISHED}.log`), 10, now),
    recent: log(join(runtime, `${RECENT}.log`), 1, now),
    running: log(join(runtime, `${RUNNING}.log`), 10, now),
    unknown: log(join(runtime, `${UNKNOWN}.log`), 10, now),
    abandoned: log(join(runtime, `${ABANDONED}.log`), 40, now),
    health: log(join(health, `${HEALTH}.log`), 10, now),
    misnamed: log(join(runtime, "notes.log"), 40, now),
    outside: log(join(home, "runtime", `${FINISHED}.log`), 40, now),
  };
  const states = new Map([
    [FINISHED, true],
    [RECENT, true],
    [RUNNING, false],
    [HEALTH, true],
  ]);
  const finished = (id: string) => states.get(id);
  const workers = [
    { root: runtime, finished },
    { root: health, finished },
  ];
  return { home, files, workers };
}

function fakeDaemon(post: (result: RunnerStorageCleanupResult) => Promise<unknown>) {
  const commands: RunnerCommand[] = [];
  const acknowledged = new Set<string>();
  return {
    commands,
    acknowledged,
    pendingCommands: () => commands.filter((command) => !acknowledged.has(command.id)),
    acknowledgeCommand: async (id: string) => void acknowledged.add(id),
    postStorageCleanup: post,
  };
}

const cleanupCommand = (id: string, mode: "preview" | "run", items?: string[]): RunnerCommand => ({
  id,
  type: "storage.cleanup",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: 1,
  expiresAt: NOW + DAY,
  cleanupId: mode === "preview" ? "01KP0000000000000000000000" : "01KR0000000000000000000000",
  mode,
  category: "worker_logs",
  olderThanDays: 7,
  ...(items === undefined ? {} : { items }),
});

test("a runner previews old logs of finished executions, deletes only those and answers a retry from its record", async () => {
  const { home, files, workers } = runnerHome(NOW);
  const posted: RunnerStorageCleanupResult[] = [];
  const daemon = fakeDaemon(async (result) => void posted.push(result));
  const cleaner = createRunnerStorageCleaner({
    root: home,
    daemon,
    workers: () => workers,
    now: () => NOW,
  });
  daemon.commands.push(cleanupCommand("preview", "preview"));
  await cleaner.tick();
  const preview = posted[0]!;
  if (preview.mode !== "preview") throw new Error("expected a preview");
  const refs = preview.items.map((item) => item.ref).sort();
  expect(refs).toEqual([`${FINISHED}.log`, `${ABANDONED}.log`, `${HEALTH}.log`]);
  expect(preview.items.every((item) => item.bytes >= 8192)).toBe(true);
  expect(preview.kept).toEqual(
    expect.arrayContaining([
      { reason: "execution is running", count: 1 },
      { reason: "newer than 7 days", count: 1 },
      { reason: "unknown execution, newer than 30 days", count: 1 },
      { reason: "not an execution log name", count: 1 },
    ]),
  );
  expect(daemon.acknowledged.has("preview")).toBe(true);

  daemon.commands.push(
    cleanupCommand("run", "run", [...refs, "../runtime/notes.log", "notes.log", `${RUNNING}.log`]),
  );
  await cleaner.tick();
  const run = posted[1]!;
  if (run.mode !== "run") throw new Error("expected a run");
  expect(run.deleted.map((item) => item.ref).sort()).toEqual(refs);
  expect(run.skipped).toEqual([
    { ref: "../runtime/notes.log", reason: "not an execution log name" },
    { ref: "notes.log", reason: "not an execution log name" },
    { ref: `${RUNNING}.log`, reason: "execution is running" },
  ]);
  expect(run.freedBytes).toBe(run.deleted.reduce((sum, item) => sum + item.bytes, 0));
  for (const kept of [files.recent, files.running, files.unknown, files.misnamed, files.outside])
    expect(existsSync(kept)).toBe(true);
  for (const gone of [files.finished, files.abandoned, files.health])
    expect(existsSync(gone)).toBe(false);

  log(files.finished, 10, NOW);
  daemon.commands.push(cleanupCommand("retry", "run", refs));
  await cleaner.tick();
  expect(posted[2]).toEqual(run);
  expect(existsSync(files.finished)).toBe(true);
});

describePglite((connect) => {
  test("the server previews and runs a runner's cleanup through storage.cleanup and keeps one pending", async () => {
    const { db, close } = await connect();
    closers.push(close);
    const { pair } = await workspaceWithRunners(db);
    const current = await pair("current", 1, null);
    const old = await pair("old", 1, null);
    const host = (runnerId: string, runnerVersion: string) => (q: Q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId, runnerVersion, reportedAt: NOW })
        .onConflictDoUpdate({ target: q.t.runnerHostStatus.runnerId, set: { runnerVersion } });
    await seed(db, host(current, "0.1.103"), host(old, "0.1.101"));
    const clock = { now: NOW };
    const sent: RunnerCommand[] = [];
    const service = createStorageCleanup({
      paths: pawsPaths(join(root, "paws")),
      store: db,
      removeCloseoutLog: async () => undefined,
      now: () => clock.now,
      runners: async () => ({
        *enqueueSteps(_q: Q, command: RunnerCommand) {
          sent.push(command);
          yield* [];
        },
      }),
    });
    const request = (method: string, path: string, body?: unknown) =>
      handleStorageCleanupRequest(
        new Request(`http://127.0.0.1:8787/api/settings/storage-cleanup${path}`, {
          method,
          headers: { "x-paws-csrf": "csrf", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        { cleanup: service, csrfToken: "csrf", role: "admin", actor: "user-1" },
      );
    const { home, files, workers } = runnerHome(NOW);
    const daemon = fakeDaemon(async (result) =>
      (
        await service.fetch(
          new Request("https://runner.invalid/v1/storage-cleanup", {
            method: "POST",
            body: JSON.stringify(result),
          }),
          current,
        )
      )?.json(),
    );
    const cleaner = createRunnerStorageCleaner({
      root: home,
      daemon,
      workers: () => workers,
      now: () => NOW,
    });

    const preview = (machine: string) =>
      request("POST", "/preview", { machine, categories: ["worker_logs"] });
    const started = await preview(current);
    expect(started?.status).toBe(202);
    const { id } = (await started!.json()) as { id: string };
    expect((await preview(current))?.status).toBe(409);
    expect(await (await preview(old))!.json()).toEqual(
      expect.objectContaining({ state: "unsupported" }),
    );
    expect((await request("POST", "/run", { previewId: id }))?.status).toBe(409);
    expect(sent.map((command) => command.type === "storage.cleanup" && command.mode)).toEqual([
      "preview",
    ]);

    daemon.commands.push(...sent.splice(0));
    await cleaner.tick();
    const answered = (await (await request("GET", `/preview?id=${id}`))!.json()) as {
      pending: boolean;
      items: { category: string; ref: string }[];
    };
    expect(answered.pending).toBe(false);
    expect(answered.items.map((item) => item.ref).sort()).toEqual([
      `${FINISHED}.log`,
      `${ABANDONED}.log`,
      `${HEALTH}.log`,
    ]);

    const run = await request("POST", "/run", { previewId: id });
    expect(run?.status).toBe(202);
    expect((await preview(current))?.status).toBe(409);
    daemon.commands.push(...sent.splice(0));
    await cleaner.tick();
    expect(existsSync(files.finished)).toBe(false);
    expect(existsSync(files.running)).toBe(true);
    const [row] = (await (await request("GET", "/history"))!.json()) as {
      machine: string;
      actor: string;
      finishedAt: number | null;
      deleted: { category: string; ref: string }[];
    }[];
    expect(row).toEqual(
      expect.objectContaining({ machine: current, actor: "user-1", finishedAt: NOW }),
    );
    expect(row!.deleted.map((item) => item.category)).toEqual(Array(3).fill("worker_logs"));

    await service.save({
      schedule: { enabled: true, timeUtc: "00:00", machines: [current] },
      categories: {
        temporary: { enabled: false, olderThanHours: 24 },
        closeout_logs: { enabled: false },
        worker_logs: { enabled: true, olderThanDays: 7 },
      },
    });
    await service.tick();
    await service.tick();
    expect(sent.map((command) => command.type === "storage.cleanup" && command.mode)).toEqual([
      "preview",
    ]);
    daemon.commands.push(...sent.splice(0));
    await cleaner.tick();
    expect(sent.map((command) => command.type === "storage.cleanup" && command.mode)).toEqual([
      "run",
    ]);
  });
});
