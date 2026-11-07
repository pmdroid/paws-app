import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  closeoutTasksOfItem,
  getCloseoutEvidenceObject,
  listCloseoutEvidenceObjects,
  saveCloseoutEvidenceObject,
} from "../db";
import { journalCaught } from "../journal";
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
  db: Database,
  storage: EvidenceStorage,
  taskId: string,
  now: () => number = Date.now,
): Promise<number> {
  const objects = storage.objects?.();
  const task = closeoutTaskDirectory(taskId);
  if (!objects || !safeTask(task)) return 0;
  const directory = join(storage.root, task);
  let published = 0;
  for await (const parts of files(directory)) {
    const path = parts.join("/");
    if (!safePath(path)) continue;
    const file = Bun.file(join(directory, ...parts));
    const previous = getCloseoutEvidenceObject(db, task, path);
    if (previous?.sha256 === (await sha256Of(file.stream()))) continue;
    const prefix = ["closeout-evidence", task, ...parts, randomUUID()].join("/");
    const hash = createHash("sha256");
    async function* hashed() {
      for await (const bytes of file.stream()) {
        hash.update(bytes);
        yield bytes;
      }
    }
    const sizeBytes = await writeEvidenceChunks(objects, prefix, hashed());
    const sha256 = hash.digest("hex");
    saveCloseoutEvidenceObject(db, { task, path, prefix, sizeBytes, sha256, storedAt: now() });
    if (previous) await removeEvidenceChunks(objects, previous.prefix, previous.sizeBytes);
    published++;
  }
  return published;
}

export async function hydrateCloseoutEvidence(
  db: Database,
  storage: EvidenceStorage,
  taskIds: readonly string[],
): Promise<number> {
  const objects = storage.objects?.();
  if (!objects) return 0;
  const tasks = taskIds.map(closeoutTaskDirectory).filter(safeTask);
  let restored = 0;
  for (const row of listCloseoutEvidenceObjects(db, tasks)) {
    if (!safeTask(row.task) || !safePath(row.path)) continue;
    const target = join(storage.root, row.task, ...row.path.split("/"));
    if (
      await lstat(target).then(
        () => true,
        () => false,
      )
    )
      continue;
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
      await rename(temporary, target);
      restored++;
    } catch (error) {
      await rm(temporary, { force: true });
      journalCaught(error, "evidence.hydrateCloseoutEvidence", null);
    }
  }
  return restored;
}

export function hydrateItemCloseoutEvidence(
  db: Database,
  storage: EvidenceStorage,
  ref: string,
  sessionIds?: readonly string[],
): Promise<number> {
  return hydrateCloseoutEvidence(db, storage, closeoutTasksOfItem(db, ref, sessionIds));
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
  db: Database,
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
      uploaded += await publishCloseoutEvidence(db, storage, entry.name);
    } catch (error) {
      journalCaught(error, "evidence.uploadLocalCloseoutEvidence", null);
    }
  }
  return uploaded;
}
