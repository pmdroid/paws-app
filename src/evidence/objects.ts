import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteEvidenceObject,
  getEvidenceObject,
  localEvidenceFiles,
  saveEvidenceObject,
  type EvidenceObject,
} from "../db";
import { journalCaught } from "../journal";
import { RUN_FILE_CHUNK_BYTES, type RunFileObjects } from "../run-files";

export type EvidenceObjects = () => RunFileObjects | null;

export type EvidenceStorage = { root: string; objects?: EvidenceObjects | undefined };

type Location = { itemId: string; headCommit: string; checkId: string };

export function evidenceObjectPrefix(location: Location, id: string): string {
  return ["evidence", location.itemId, location.headCommit.toLowerCase(), location.checkId, id]
    .map(encodeURIComponent)
    .join("/");
}

export async function writeEvidenceChunks(
  objects: RunFileObjects,
  prefix: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<number> {
  let size = 0;
  let pending = Buffer.alloc(0);
  let written = 0;
  try {
    for await (const part of source) {
      size += part.byteLength;
      pending = Buffer.concat([pending, part]);
      for (; pending.byteLength >= RUN_FILE_CHUNK_BYTES; written++) {
        await objects.write(`${prefix}/${written}`, pending.subarray(0, RUN_FILE_CHUNK_BYTES));
        pending = pending.subarray(RUN_FILE_CHUNK_BYTES);
      }
    }
    if (pending.byteLength > 0) await objects.write(`${prefix}/${written}`, pending);
    return size;
  } catch (error) {
    await removeEvidenceChunks(objects, prefix, (written + 1) * RUN_FILE_CHUNK_BYTES);
    throw error;
  }
}

export async function removeEvidenceChunks(
  objects: RunFileObjects,
  prefix: string,
  size: number,
): Promise<void> {
  for (let n = 0; n * RUN_FILE_CHUNK_BYTES < size; n++)
    await objects
      .delete(`${prefix}/${n}`)
      .catch((error: unknown) => journalCaught(error, "evidence.removeEvidenceChunks", null));
}

export async function writeEvidenceFile(
  db: Database,
  storage: EvidenceStorage,
  location: Location,
  id: string,
  bytes: Uint8Array,
  now: number,
): Promise<void> {
  const objects = storage.objects?.();
  if (!objects) {
    await mkdir(storage.root, { recursive: true, mode: 0o700 });
    await chmod(storage.root, 0o700);
    await writeFile(join(storage.root, id), bytes, { flag: "wx", mode: 0o600 });
    return;
  }
  const prefix = evidenceObjectPrefix(location, id);
  const sizeBytes = await writeEvidenceChunks(objects, prefix, [bytes]);
  saveEvidenceObject(db, { id, prefix, sizeBytes, storedAt: now });
}

export async function removeEvidenceFile(
  db: Database,
  storage: EvidenceStorage,
  id: string,
): Promise<void> {
  const row = getEvidenceObject(db, id);
  if (row) {
    const objects = storage.objects?.();
    if (objects) await removeEvidenceChunks(objects, row.prefix, row.sizeBytes);
    deleteEvidenceObject(db, id);
  }
  await rm(join(storage.root, id), { force: true });
}

export async function openEvidenceFile(
  db: Database,
  storage: EvidenceStorage,
  id: string,
  range?: { start: number; end: number },
): Promise<{ size: number; body: Blob | ReadableStream<Uint8Array> } | null> {
  const row = getEvidenceObject(db, id);
  const objects = row === null ? null : storage.objects?.();
  if (row === null || !objects) {
    const file = Bun.file(join(storage.root, id));
    if (!(await file.exists())) return null;
    return { size: file.size, body: range ? file.slice(range.start, range.end + 1) : file };
  }
  const chunks = readChunks(objects, row, range?.start ?? 0, range?.end ?? row.sizeBytes - 1);
  let first: IteratorResult<Uint8Array>;
  try {
    first = await chunks.next();
  } catch (error) {
    journalCaught(error, "evidence.openEvidenceFile.read", null, "the object may be absent");
    return null;
  }
  let pending: IteratorResult<Uint8Array> | undefined = first;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = pending ?? (await chunks.next());
      pending = undefined;
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return { size: row.sizeBytes, body };
}

export async function* readChunks(
  objects: RunFileObjects,
  row: Pick<EvidenceObject, "prefix" | "sizeBytes">,
  start: number,
  end: number,
) {
  for (let n = Math.floor(start / RUN_FILE_CHUNK_BYTES); n * RUN_FILE_CHUNK_BYTES <= end; n++) {
    const offset = n * RUN_FILE_CHUNK_BYTES;
    const bytes = await objects.read(`${row.prefix}/${n}`);
    if (bytes.byteLength !== Math.min(RUN_FILE_CHUNK_BYTES, row.sizeBytes - offset))
      throw new Error("Evidence chunk has the wrong size");
    yield bytes.subarray(Math.max(0, start - offset), end - offset + 1);
  }
}

export async function readEvidenceBytes(
  db: Database,
  storage: EvidenceStorage,
  id: string,
): Promise<Uint8Array> {
  const file = await openEvidenceFile(db, storage, id);
  if (file === null) throw new Error(`Evidence file ${id} is missing`);
  return new Uint8Array(await new Response(file.body).arrayBuffer());
}

export async function uploadLocalEvidence(
  db: Database,
  storage: EvidenceStorage,
  now: () => number = Date.now,
): Promise<number> {
  const objects = storage.objects?.();
  if (!objects) return 0;
  let uploaded = 0;
  for (const file of localEvidenceFiles(db)) {
    const local = Bun.file(join(storage.root, file.id));
    if (!(await local.exists())) continue;
    const prefix = `${evidenceObjectPrefix(file, file.id)}/${randomUUID()}`;
    try {
      const sizeBytes = await writeEvidenceChunks(objects, prefix, local.stream());
      if (saveEvidenceObject(db, { id: file.id, prefix, sizeBytes, storedAt: now() })) uploaded++;
      else await removeEvidenceChunks(objects, prefix, sizeBytes);
    } catch (error) {
      journalCaught(error, "evidence.uploadLocalEvidence", file.itemId);
    }
  }
  return uploaded;
}
