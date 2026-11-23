import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ensureLayout, pawsPaths, type PawsPaths } from "../src/config";
import type { Db } from "../src/db";
import { storageCleanup, workItem } from "../src/db/schema-pg";
import { handleStorageCleanupRequest } from "../src/settings";
import { createStorageCleanup } from "../src/storage-cleanup";
import { describePglite, insertWorkItem } from "./pglite-fixtures";

const HOUR = 3_600_000;
const RUNNING = "01KAAAAAAAAAAAAAAAAAAAAAAA";
const MERGED = "01KBBBBBBBBBBBBBBBBBBBBBBB";
let root: string;
let paths: PawsPaths;
const closers: (() => unknown)[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-storage-cleanup-"));
  paths = pawsPaths(join(root, "home"));
  ensureLayout(paths);
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(root, { recursive: true, force: true });
});

function entry(name: string, ageHours: number, now: number) {
  const path = join(paths.tmpDir, name);
  mkdirSync(path);
  writeFileSync(join(path, "data"), Buffer.alloc(8192, 1));
  const seconds = (now - ageHours * HOUR) / 1000;
  utimesSync(path, seconds, seconds);
}

const setState = (db: Db, id: string, state: string) =>
  db.orm.update(workItem).set({ state }).where(eq(workItem.id, id));

describePglite((connect) => {
  async function service(clock: { now: number }) {
    const { db, close } = await connect();
    closers.push(close);
    for (const [id, state] of [
      [RUNNING, "running"],
      [MERGED, "merged"],
    ] as const) {
      await insertWorkItem(db, id);
      await setState(db, id, state);
    }
    const cleanup = createStorageCleanup({
      paths,
      store: db,
      removeCloseoutLog: async () => undefined,
      now: () => clock.now,
    });
    return { db, cleanup };
  }

  const request = (
    cleanup: Parameters<typeof handleStorageCleanupRequest>[1]["cleanup"],
    method: string,
    path: string,
    body?: unknown,
    role = "admin",
  ) =>
    handleStorageCleanupRequest(
      new Request(`http://127.0.0.1:8787/api/settings/storage-cleanup${path}`, {
        method,
        headers: { "x-paws-csrf": "csrf", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { cleanup, csrfToken: "csrf", role, actor: "user-1" },
    );

  test("a preview lists old finished entries and keeps active, recent and young ownerless ones", async () => {
    const clock = { now: Date.UTC(2026, 10, 23, 12) };
    const { cleanup } = await service(clock);
    entry(`paws-git-${RUNNING}-aaaaaa`, 48, clock.now);
    entry(`paws-git-${MERGED}-bbbbbb`, 48, clock.now);
    entry(`paws-rebase-${MERGED}-cccccc`, 2, clock.now);
    entry("paws-git-ownerless", 48, clock.now);
    entry("paws-publication-ancient", 8 * 24, clock.now);
    const response = await request(cleanup, "POST", "/preview", {
      machine: "server",
      categories: ["temporary"],
    });
    expect(response?.status).toBe(200);
    const preview = (await response!.json()) as {
      id: string;
      expiresAt: number;
      items: { category: string; ref: string; bytes: number }[];
      kept: { category: string; reason: string; count: number }[];
    };
    expect(preview.expiresAt).toBe(clock.now + 15 * 60_000);
    expect(preview.items.map((item) => item.ref).sort()).toEqual([
      `paws-git-${MERGED}-bbbbbb`,
      "paws-publication-ancient",
    ]);
    expect(preview.items.every((item) => item.bytes >= 8192)).toBe(true);
    expect(preview.kept).toEqual(
      expect.arrayContaining([
        { category: "temporary", reason: "owner is running", count: 1 },
        { category: "temporary", reason: "newer than 24 hours", count: 1 },
        { category: "temporary", reason: "no known owner, newer than 7 days", count: 1 },
      ]),
    );
  });

  test("a run deletes only previewed items, skips one that became protected and logs both", async () => {
    const clock = { now: Date.UTC(2026, 10, 23, 12) };
    const { db, cleanup } = await service(clock);
    entry(`paws-git-${MERGED}-bbbbbb`, 48, clock.now);
    entry("paws-publication-ancient", 8 * 24, clock.now);
    const preview = (await cleanup.preview({ machine: "server", categories: ["temporary"] }))
      .body as { id: string };
    entry("paws-git-unlisted", 9 * 24, clock.now);
    await setState(db, MERGED, "verifying");
    clock.now += 60_000;
    const response = await request(cleanup, "POST", "/run", { previewId: preview.id });
    expect(response?.status).toBe(200);
    expect(readdirSync(paths.tmpDir).sort()).toEqual([
      `paws-git-${MERGED}-bbbbbb`,
      "paws-git-unlisted",
    ]);
    const [row] = await db.orm.select().from(storageCleanup);
    expect(row).toMatchObject({ machine: "server", actor: "user-1", error: null });
    expect(row!.deleted).toEqual([
      { category: "temporary", ref: "paws-publication-ancient", bytes: expect.any(Number) },
    ]);
    expect(row!.skipped).toEqual([
      { category: "temporary", ref: `paws-git-${MERGED}-bbbbbb`, reason: "owner is verifying" },
    ]);
    expect(row!.freedBytes).toBeGreaterThanOrEqual(8192);
    const history = (await (await request(cleanup, "GET", "/history"))!.json()) as unknown[];
    expect(history).toHaveLength(1);
    const again = await request(cleanup, "POST", "/run", { previewId: preview.id });
    expect(again?.status).toBe(404);
  });

  test("an expired preview returns 410 and deletes nothing", async () => {
    const clock = { now: Date.UTC(2026, 10, 23, 12) };
    const { db, cleanup } = await service(clock);
    entry("paws-publication-ancient", 8 * 24, clock.now);
    const preview = (await cleanup.preview({ machine: "server" })).body as { id: string };
    clock.now += 15 * 60_000;
    expect((await request(cleanup, "POST", "/run", { previewId: preview.id }))?.status).toBe(410);
    expect(existsSync(join(paths.tmpDir, "paws-publication-ancient"))).toBe(true);
    expect(await db.orm.select().from(storageCleanup)).toHaveLength(0);
  });

  test("the schedule runs once a day and once after an offline period", async () => {
    const clock = { now: Date.UTC(2026, 10, 23, 2) };
    const { db, cleanup } = await service(clock);
    const settings = {
      schedule: { enabled: true, timeUtc: "03:00", machines: ["server", "runner-1"] },
      categories: {
        temporary: { enabled: true, olderThanHours: 24 },
        closeout_logs: { enabled: false },
      },
    };
    expect((await request(cleanup, "PUT", "", settings))?.status).toBe(200);
    const workerLogs = { enabled: false, olderThanDays: 7 };
    expect(await (await request(cleanup, "GET", ""))!.json()).toEqual({
      ...settings,
      categories: { ...settings.categories, worker_logs: workerLogs },
    });
    const runs = async () => (await db.orm.select().from(storageCleanup)).length;
    await cleanup.tick();
    expect(await runs()).toBe(1);
    for (const at of [Date.UTC(2026, 10, 23, 2, 30), Date.UTC(2026, 10, 23, 2, 55)]) {
      clock.now = at;
      await cleanup.tick();
    }
    expect(await runs()).toBe(1);
    clock.now = Date.UTC(2026, 10, 23, 3, 5);
    await cleanup.tick();
    await cleanup.tick();
    expect(await runs()).toBe(2);
    clock.now = Date.UTC(2026, 10, 28, 9);
    await cleanup.tick();
    await cleanup.tick();
    expect(await runs()).toBe(3);
    const rows = await db.orm.select().from(storageCleanup);
    expect(rows.every((row) => row.actor === "schedule" && row.machine === "server")).toBe(true);
  });

  test("the startup sweep deletes only what the same rule allows", async () => {
    const clock = { now: Date.UTC(2026, 10, 23, 12) };
    const { db, cleanup } = await service(clock);
    entry(`paws-git-${RUNNING}-aaaaaa`, 48, clock.now);
    entry("paws-git-ownerless", 48, clock.now);
    entry("paws-git-ancient", 8 * 24, clock.now);
    await cleanup.sweep();
    expect(readdirSync(paths.tmpDir).sort()).toEqual([
      `paws-git-${RUNNING}-aaaaaa`,
      "paws-git-ownerless",
    ]);
    const [row] = await db.orm.select().from(storageCleanup);
    expect(row?.actor).toBe("startup");
  });

  test("settings refuse categories outside the closed list, and non-admins get 403 everywhere", async () => {
    const clock = { now: Date.UTC(2026, 10, 23, 12) };
    const { cleanup } = await service(clock);
    const put = await request(cleanup, "PUT", "", {
      schedule: { enabled: false, timeUtc: "03:00", machines: [] },
      categories: {
        temporary: { enabled: true, olderThanHours: 24 },
        closeout_logs: { enabled: true },
        secrets: { enabled: true },
      },
    });
    expect(put?.status).toBe(400);
    const preview = await request(cleanup, "POST", "/preview", {
      machine: "server",
      categories: ["old_backups"],
    });
    expect(preview?.status).toBe(400);
    for (const [method, path] of [
      ["GET", ""],
      ["PUT", ""],
      ["POST", "/preview"],
      ["POST", "/run"],
      ["GET", "/history"],
    ] as const)
      expect((await request(cleanup, method, path, {}, "member"))?.status).toBe(403);
  });
});
