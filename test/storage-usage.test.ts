import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pawsPaths } from "../src/config";
import { storageSnapshot } from "../src/db/schema-pg";
import { handleStorageUsageRequest } from "../src/settings";
import { createStorageUsage, scanStorage, type StorageUsage } from "../src/storage-usage";
import { describePglite } from "./pglite-fixtures";

let root: string;
let home: string;
const cleanup: (() => unknown)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-storage-usage-"));
  home = join(root, "home");
  mkdirSync(home);
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  rmSync(root, { recursive: true, force: true });
});

const allocated = (paths: string[]) =>
  paths.reduce((sum, path) => sum + Number(lstatSync(path).blocks) * 512, 0);

function file(path: string, size = 64 * 1024): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 7));
  return path;
}

function layout() {
  const paths = pawsPaths(home);
  const files = {
    transcripts: [file(join(home, "runner-transcripts", "a", "t.jsonl"))],
    run_files: [file(join(paths.runsDir, "r1", "x.bin")), file(join(paths.runsDir, "r2", "y.bin"))],
    closeout: [file(join(home, "closeout", "tmp", "logs", "l.txt"))],
    evidence: [file(join(paths.evidenceDir, "e.png"))],
    tasks: [file(join(home, "tasks", "PAS-1", "classify", "out.json"))],
    repositories: [file(join(paths.reposDir, "acme", "app.git", "pack"))],
    worktrees: [] as string[],
    secrets: [file(join(paths.secretsDir, "github-app-private-key.pem"))],
    temporary: [file(join(paths.tmpDir, "git-123", "x"))],
    deploy_dumps: [
      file(join(home, "pg-backup-predeploy-1.dump")),
      file(join(home, "pg-backup-predeploy-2.dump")),
    ],
    old_backups: [file(join(home, "backups", "paws.db.1")), file(join(home, "paws.db.old"))],
    other: [file(join(home, "config.toml"), 100), file(join(home, "pglite", "base", "1"))],
  };
  mkdirSync(paths.worktreesDir);
  const outside = file(join(root, "outside", "big.bin"), 512 * 1024);
  const evidenceLink = join(paths.evidenceDir, "outside");
  symlinkSync(join(root, "outside"), evidenceLink);
  files.evidence.push(evidenceLink);
  const hardLink = join(home, "tasks-copy");
  linkSync(files.tasks[0]!, hardLink);
  return { paths, files, outside };
}

const dirsUnder = (top: string, files: string[]) => {
  const dirs = new Set<string>();
  for (const path of files)
    for (let dir = dirname(path); dir.startsWith(top) && dir !== home; dir = dirname(dir))
      dirs.add(dir);
  return [...dirs];
};

test("a scan measures each category once, counting a hard link once and not following symlinks", async () => {
  const { paths, files } = layout();
  const scan = await scanStorage(paths, { deadline: Date.now() + 60_000 });
  expect(scan.partial).toBe(false);
  const tops: Record<string, string> = {
    transcripts: join(home, "runner-transcripts"),
    run_files: paths.runsDir,
    closeout: join(home, "closeout"),
    evidence: paths.evidenceDir,
    tasks: join(home, "tasks"),
    repositories: paths.reposDir,
    worktrees: paths.worktreesDir,
    secrets: paths.secretsDir,
    temporary: paths.tmpDir,
    old_backups: join(home, "backups"),
    other: join(home, "pglite"),
  };
  for (const [category, entries] of Object.entries(files)) {
    const top = tops[category];
    const dirs = top === undefined ? [] : dirsUnder(top, entries);
    if (top !== undefined && !dirs.includes(top)) dirs.push(top);
    const expected =
      allocated([...entries, ...dirs]) + (category === "other" ? allocated([home]) : 0);
    expect([category, scan.categories[category as keyof typeof files]]).toEqual([
      category,
      { bytes: expected, files: entries.length },
    ]);
  }
  expect(scan.categories.evidence!.bytes).toBeLessThan(512 * 1024);
  expect(JSON.stringify(scan)).not.toContain("github-app-private-key");
  expect(scan.filesystems.home?.totalBytes).toBeGreaterThan(0);
});

describePglite((connect) => {
  async function usage(extra: Partial<Parameters<typeof createStorageUsage>[0]> = {}) {
    const { db, close } = await connect();
    cleanup.push(close);
    const service = createStorageUsage({ paths: pawsPaths(home), store: db, ...extra });
    cleanup.push(() => service.stop());
    return Object.assign(service, { db });
  }

  const request = (service: StorageUsage, method: string, path: string, role = "admin") =>
    handleStorageUsageRequest(
      new Request(`http://127.0.0.1:8787${path}`, {
        method,
        headers: { "x-paws-csrf": "csrf" },
      }),
      { usage: service, csrfToken: "csrf", role },
    );

  test("a scan that hits its cap is stored as partial with the categories it finished", async () => {
    layout();
    let clock = 1_000_000;
    const service = await usage({ now: () => (clock += 1), limitMs: 5 });
    await service.refresh();
    const view = await service.read();
    expect(view.snapshots).toHaveLength(1);
    const [snapshot] = view.snapshots;
    expect(snapshot!.machine).toBe("server");
    expect(snapshot!.partial).toBe(true);
    expect(Object.keys(snapshot!.categories).length).toBeLessThan(12);
  });

  test("a second refresh while a scan runs gets 409, and the result is readable", async () => {
    layout();
    const service = await usage();
    const first = await request(service, "POST", "/api/settings/storage-usage/refresh");
    expect(first?.status).toBe(202);
    const second = await request(service, "POST", "/api/settings/storage-usage/refresh");
    expect(second?.status).toBe(409);
    while ((await service.read()).scanning) await Bun.sleep(10);
    const read = await request(service, "GET", "/api/settings/storage-usage");
    expect(read?.status).toBe(200);
    const body = (await read!.json()) as Awaited<ReturnType<StorageUsage["read"]>>;
    expect(body.snapshots[0]?.partial).toBe(false);
    expect(Object.keys(body.snapshots[0]!.categories)).toHaveLength(12);
    expect(body.live.home?.freeBytes).toBeGreaterThan(0);
  });

  test("only workspace admins can read or refresh storage usage", async () => {
    const service = await usage();
    for (const [method, path] of [
      ["GET", "/api/settings/storage-usage"],
      ["POST", "/api/settings/storage-usage/refresh"],
    ] as const)
      expect((await request(service, method, path, "member"))?.status).toBe(403);
    expect((await service.read()).scanning).toBe(false);
  });

  test("only the last 30 snapshots per machine are kept", async () => {
    let clock = 0;
    const service = await usage({ now: () => (clock += 1000) });
    for (let index = 0; index < 32; index++) await service.refresh();
    const rows = await service.db.orm.select().from(storageSnapshot);
    expect(rows).toHaveLength(30);
    expect((await service.read()).snapshots[0]?.takenAt).toBe(
      Math.max(...rows.map((row) => row.takenAt)),
    );
  });
});
