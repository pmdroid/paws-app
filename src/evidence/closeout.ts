import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  closeoutTasksOfItemSteps,
  getCloseoutEvidenceObjectSteps,
  insertCloseoutEvidenceObjectSteps,
  listCloseoutEvidenceObjectsSteps,
  saveCloseoutEvidenceObjectSteps,
  type CloseoutEvidenceObject,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import type { RunFileObjects } from "../run-files";
import {
  readChunks,
  removeEvidenceChunks,
  writeEvidenceChunks,
  type EvidenceStorage,
} from "./objects";

export function closeoutTaskDirectory(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

function safeTask(task: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(task) && task !== "." && task !== "..";
}

function safePath(path: string): boolean {
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !/[\\\0]/.test(part));
}

async function* files(root: string, relative: string[] = []): AsyncGenerator<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, ...relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.endsWith(".lock")) continue;
    if (entry.isDirectory()) yield* files(root, [...relative, entry.name]);
    else if (entry.isFile()) yield [...relative, entry.name];
  }
}

async function sha256Of(source: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of source) hash.update(bytes);
  return hash.digest("hex");
}

export async function publishCloseoutEvidence(
  store: Db,
  storage: EvidenceStorage,
  taskId: string,
  options: { now?: () => number; keepStored?: boolean } = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const objects = storage.objects?.();
  const task = closeoutTaskDirectory(taskId);
  if (!objects || !safeTask(task)) return 0;
  const directory = join(storage.root, task);
  let published = 0;
  for await (const parts of files(directory)) {
    const path = parts.join("/");
    if (!safePath(path)) continue;
    const file = Bun.file(join(directory, ...parts));
    const info = await stat(join(directory, ...parts));
    const modifiedAt = Math.floor(info.mtimeMs);
    const previous = await store.run((q) => getCloseoutEvidenceObjectSteps(q, task, path));
    if (previous && options.keepStored) continue;
    if (previous?.sizeBytes === info.size && previous.modifiedAt === modifiedAt) continue;
    if (previous?.sha256 === (await sha256Of(file.stream()))) {
      await store.run((q) => saveCloseoutEvidenceObjectSteps(q, { ...previous, modifiedAt }));
      continue;
    }
    const prefix = ["closeout-evidence", task, ...parts, randomUUID()].join("/");
    const hash = createHash("sha256");
    async function* hashed() {
      for await (const bytes of file.stream()) {
        hash.update(bytes);
        yield bytes;
      }
    }
    const sizeBytes = await writeEvidenceChunks(objects, prefix, hashed());
    const row = {
      task,
      path,
      prefix,
      sizeBytes,
      sha256: hash.digest("hex"),
      modifiedAt,
      storedAt: now(),
    };
    if (options.keepStored) {
      if (!(await store.run((q) => insertCloseoutEvidenceObjectSteps(q, row)))) {
        await removeEvidenceChunks(objects, prefix, sizeBytes);
        continue;
      }
    } else await store.run((q) => saveCloseoutEvidenceObjectSteps(q, row));
    if (previous) await removeEvidenceChunks(objects, previous.prefix, previous.sizeBytes);
    published++;
  }
  return published;
}

export async function hydrateCloseoutEvidence(
  store: Db,
  storage: EvidenceStorage,
  taskIds: readonly string[],
  options: { strict?: boolean } = {},
): Promise<number> {
  const objects = storage.objects?.();
  if (!objects) return 0;
  const tasks = taskIds.map(closeoutTaskDirectory).filter(safeTask);
  let restored = 0;
  let unrestored: { error: unknown } | null = null;
  for (const row of await store.run((q) => listCloseoutEvidenceObjectsSteps(q, tasks))) {
    if (!safeTask(row.task) || !safePath(row.path)) continue;
    const target = join(storage.root, row.task, ...row.path.split("/"));
    const local = await lstat(target).catch(() => null);
    if (local?.isFile() && local.size === row.sizeBytes) {
      if (Math.floor(local.mtimeMs) === row.modifiedAt) continue;
      if ((await sha256Of(Bun.file(target).stream()).catch(() => null)) === row.sha256) continue;
    }
    try {
      await restoreCloseoutFile(objects, row, target).catch(async (error: unknown) => {
        const current = await store.run((q) =>
          getCloseoutEvidenceObjectSteps(q, row.task, row.path),
        );
        if (current === null || current.prefix === row.prefix) throw error;
        await restoreCloseoutFile(objects, current, target);
      });
      restored++;
    } catch (error) {
      journalCaught(error, "evidence.hydrateCloseoutEvidence", null);
      unrestored ??= { error };
    }
  }
  if (options.strict && unrestored !== null) throw unrestored.error;
  return restored;
}

async function restoreCloseoutFile(
  objects: RunFileObjects,
  row: CloseoutEvidenceObject,
  target: string,
): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const parts: Uint8Array[] = [];
    const hash = createHash("sha256");
    for await (const bytes of readChunks(objects, row, 0, row.sizeBytes - 1)) {
      hash.update(bytes);
      parts.push(bytes);
    }
    if (hash.digest("hex") !== row.sha256)
      throw new Error("Closeout evidence object failed its integrity check");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temporary, Buffer.concat(parts), { flag: "wx", mode: 0o600 });
    await utimes(temporary, row.modifiedAt / 1000, row.modifiedAt / 1000);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function hydrateItemCloseoutEvidence(
  db: Db,
  storage: EvidenceStorage,
  ref: string,
  sessionIds?: readonly string[],
): Promise<number> {
  const tasks = await db.run((q) => closeoutTasksOfItemSteps(q, ref, sessionIds));
  return hydrateCloseoutEvidence(db, storage, tasks);
}

export function closeoutEvidenceItemOf(request: Request): string | null {
  const url = new URL(request.url);
  if (url.pathname === "/api/closeout-artifact") return url.searchParams.get("item") || null;
  const match = /^\/api\/issues\/([^/]+)/.exec(url.pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export async function uploadLocalCloseoutEvidence(
  db: Db,
  storage: EvidenceStorage,
): Promise<number> {
  if (!storage.objects?.()) return 0;
  let uploaded = 0;
  let entries;
  try {
    entries = await readdir(storage.root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeTask(entry.name)) continue;
    try {
      uploaded += await publishCloseoutEvidence(db, storage, entry.name, {
        keepStored: true,
      });
    } catch (error) {
      journalCaught(error, "evidence.uploadLocalCloseoutEvidence", null);
    }
  }
  return uploaded;
}
