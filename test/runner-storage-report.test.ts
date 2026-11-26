import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pawsPaths } from "../src/config";
import { saveStorageSnapshotSteps, type Q } from "../src/db";
import {
  MINIMUM_RUNNER_VERSION,
  type RunnerCommand,
  type RunnerStorageReport,
} from "../src/runner-protocol";
import { handleStorageUsageRequest } from "../src/settings";
import {
  createRunnerStorageReporter,
  createStorageUsage,
  scanRunnerStorage,
} from "../src/storage-usage";
import { describePglite, seed } from "./pglite-fixtures";
import { NOW, workspaceWithRunners } from "./runner-slot-fixture";

let root: string;
const cleanup: (() => unknown)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-runner-storage-"));
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  rmSync(root, { recursive: true, force: true });
});

function file(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(64 * 1024, 7));
  return path;
}

function runnerHome() {
  const home = join(root, "runner");
  return {
    home,
    files: {
      repositories: [file(join(home, "repositories", "acme", "app.git", "pack"))],
      worker_logs: [
        file(join(home, "runtime", "workers", "01A.log")),
        file(join(home, "health", "workers", "01B.log")),
        file(join(home, "retro", "workers", "01C.log")),
      ],
      executions: [
        file(join(home, "runtime", "executions.db")),
        file(join(home, "runtime", "executions.db-wal")),
      ],
      health: [file(join(home, "health", "health.db"))],
      tool_caches: [file(join(home, ".bun", "install", "x")), file(join(home, ".nvm", "y"))],
      other: [file(join(home, "runtime", "workers", "01A.json")), file(join(home, "state.db"))],
    },
  };
}

test("a runner home is measured in the runner categories, each worker log once", async () => {
  const { home, files } = runnerHome();
  const scan = await scanRunnerStorage(home, { deadline: Date.now() + 60_000 });
  expect(scan.partial).toBe(false);
  for (const [category, entries] of Object.entries(files)) {
    const usage = scan.categories[category as keyof typeof files]!;
    expect([category, usage.files]).toEqual([category, entries.length]);
    const bytes = entries.reduce((sum, path) => sum + Number(lstatSync(path).blocks) * 512, 0);
    expect(usage.bytes).toBeGreaterThanOrEqual(bytes);
  }
  expect(scan.categories.worker_logs!.bytes).toBe(
    files.worker_logs.reduce((sum, path) => sum + Number(lstatSync(path).blocks) * 512, 0),
  );
  expect(scan.filesystems.home?.totalBytes).toBeGreaterThan(0);
});

test("worker logs and executions behind a symlinked folder are not counted", async () => {
  const home = join(root, "runner");
  file(join(root, "outside", "workers", "01X.log"));
  file(join(root, "outside", "executions.db"));
  file(join(home, "health", "workers", "01Y.log"));
  mkdirSync(join(home, "retro"), { recursive: true });
  symlinkSync(join(root, "outside", "workers"), join(home, "retro", "workers"));
  symlinkSync(join(root, "outside"), join(home, "runtime"));
  const scan = await scanRunnerStorage(home, { deadline: Date.now() + 60_000 });
  expect(scan.categories.worker_logs!.files).toBe(1);
  expect(scan.categories.executions).toEqual({ bytes: 0, files: 0 });
});

test("a runner refuses a second report while one runs and drops expired ones", async () => {
  const { home } = runnerHome();
  const command = (id: string, expiresAt: number): RunnerCommand => ({
    id,
    type: "storage.report",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1,
    expiresAt,
  });
  const pending = [command("first", 10_000), command("second", 10_000), command("old", 5)];
  const acknowledged: string[] = [];
  const posted: RunnerStorageReport[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reporter = createRunnerStorageReporter({
    root: home,
    now: () => 100,
    daemon: {
      pendingCommands: () => pending.filter((entry) => !acknowledged.includes(entry.id)),
      acknowledgeCommand: async (id) => void acknowledged.push(id),
      async postStorageReport(report) {
        await gate;
        posted.push(report);
      },
    },
  });
  await reporter.tick();
  expect(acknowledged).toEqual(["second", "old"]);
  release();
  await reporter.running();
  expect(acknowledged).toEqual(["second", "old", "first"]);
  expect(posted.map((report) => [report.commandId, report.takenAt])).toEqual([["first", 100]]);
  expect(Object.keys(posted[0]!.categories)).toHaveLength(6);
});

describePglite((connect) => {
  test("runners report on the scan, the server stores each per runner, and the API lists them", async () => {
    const { db, close } = await connect();
    cleanup.push(close);
    const { pair } = await workspaceWithRunners(db);
    const current = await pair("current", 1, null);
    const old = await pair("old", 1, null);
    const away = await pair("away", 1, null);
    let clock = NOW;
    const host = (q: Q, runnerId: string, runnerVersion: string) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId, runnerVersion, reportedAt: NOW })
        .onConflictDoUpdate({ target: q.t.runnerHostStatus.runnerId, set: { runnerVersion } });
    await seed(
      db,
      (q) => host(q, current, MINIMUM_RUNNER_VERSION.join(".")),
      (q) => host(q, old, "0.1.100"),
      (q) => host(q, away, MINIMUM_RUNNER_VERSION.join(".")),
      (q) =>
        q.orm
          .update(q.t.runner)
          .set({ lastSeenAt: NOW - 3_600_000 })
          .where(eq(q.t.runner.id, away)),
      (q) => q.orm.update(q.t.runner).set({ status: "draining" }).where(eq(q.t.runner.id, current)),
    );
    await db.run((q) =>
      saveStorageSnapshotSteps(q, {
        machine: away,
        takenAt: NOW - 86_400_000,
        partial: false,
        filesystems: { home: null, tmp: null },
        categories: { repositories: { bytes: 4096, files: 1 } },
      }),
    );
    const sent: RunnerCommand[] = [];
    const service = createStorageUsage({
      paths: pawsPaths(join(root, "paws")),
      store: db,
      now: () => clock,
      runners: async () => ({
        *enqueueSteps(q: Q, command: RunnerCommand) {
          sent.push(command);
          yield* q.exec(
            q.orm.insert(q.t.runnerCommand).values({
              id: command.id,
              runnerId: command.runnerId,
              kind: command.type,
              envelope: {},
              expiresAt: command.expiresAt,
            }),
          );
        },
      }),
    });
    cleanup.push(() => service.stop());
    await service.refresh();
    while (sent.length === 0) await Bun.sleep(5);
    expect(sent.map((command) => [command.type, command.runnerId])).toEqual([
      ["storage.report", current],
    ]);
    expect(await service.refreshMachine(current)).toBe("busy");
    expect(await service.refreshMachine(old)).toBe("unavailable");
    expect((await service.read()).runners.find((runner) => runner.machine === current)).toEqual(
      expect.objectContaining({ state: "missing", reporting: true }),
    );

    const { home } = runnerHome();
    const post = (runnerId: string, report: RunnerStorageReport) =>
      service.fetch(
        new Request("https://runner.invalid/v1/storage-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report),
        }),
        runnerId,
      );
    const posted: RunnerStorageReport[] = [];
    const answers: unknown[] = [];
    const acknowledged = new Set<string>();
    const reporter = createRunnerStorageReporter({
      root: home,
      now: () => clock + 5_000,
      daemon: {
        pendingCommands: () => sent.filter((command) => !acknowledged.has(command.id)),
        acknowledgeCommand: async (id) => void acknowledged.add(id),
        async postStorageReport(report) {
          posted.push(report);
          answers.push(await (await post(current, report))!.json());
        },
      },
    });
    cleanup.push(() => reporter.stop());
    await reporter.tick();
    await reporter.running();
    expect(answers).toEqual([{ duplicate: false }]);
    expect([...acknowledged]).toEqual([sent[0]!.id]);
    expect((await post(old, posted[0]!))?.status).toBe(403);
    expect(await (await post(current, posted[0]!))!.json()).toEqual({ duplicate: true });

    clock += 30_000;
    const view = await service.read();
    const byName = Object.fromEntries(view.runners.map((runner) => [runner.name, runner]));
    expect(byName.current).toEqual(
      expect.objectContaining({ state: "fresh", online: true, reporting: false, ageMs: 30_000 }),
    );
    expect(Object.keys(byName.current!.snapshot!.categories).sort()).toEqual([
      "executions",
      "health",
      "other",
      "repositories",
      "tool_caches",
      "worker_logs",
    ]);
    expect(byName.old).toEqual(expect.objectContaining({ state: "unsupported", snapshot: null }));
    expect(byName.away).toEqual(
      expect.objectContaining({ state: "stale", online: false, ageMs: 86_400_000 + 30_000 }),
    );

    const refresh = (body: unknown) =>
      handleStorageUsageRequest(
        new Request("http://127.0.0.1:8787/api/settings/storage-usage/refresh", {
          method: "POST",
          headers: { "x-paws-csrf": "csrf" },
          body: JSON.stringify(body),
        }),
        { usage: service, csrfToken: "csrf", role: "admin" },
      );
    expect((await refresh({ machine: old }))?.status).toBe(404);
    expect((await refresh({ machine: current }))?.status).toBe(202);
    expect((await refresh({ machine: current }))?.status).toBe(409);
    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerCommand)
        .set({ acknowledgedAt: clock })
        .where(eq(q.t.runnerCommand.id, sent.at(-1)!.id)),
    );
    const before = sent.length;
    const outcomes = await Promise.all([
      service.refreshMachine(current),
      service.refreshMachine(current),
    ]);
    expect(outcomes.sort()).toEqual(["busy", "started"]);
    expect(sent).toHaveLength(before + 1);
    expect((await refresh({ machine: 7 }))?.status).toBe(400);
  });
});
