import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  pointCloseoutOutputSteps,
  localCloseoutLogFiles,
  type CloseoutOutputPointer,
  type Db,
  type StoredCloseoutOutput,
} from "../db";
import { journalCaught } from "../journal";
import {
  openEvidenceFile,
  removeEvidenceFile,
  writeEvidenceFile,
  uploadLocalEvidence,
  type EvidenceObjects,
  type EvidenceStorage,
} from "./objects";
import { ulid } from "./ulid";

export type CloseoutOutput = { stdout: string; stderr: string };

export function closeoutLogStorage(home: string, objects?: EvidenceObjects): EvidenceStorage {
  return { root: join(home, "closeout", "logs"), objects };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function storeCloseoutOutput(
  store: Db,
  storage: EvidenceStorage,
  location: { itemId: string; headCommit: string; checkId: string },
  output: CloseoutOutput,
  now: number,
): Promise<CloseoutOutputPointer> {
  const bytes = Buffer.from(JSON.stringify({ stdout: output.stdout, stderr: output.stderr }));
  const key = ulid(now);
  await writeEvidenceFile(store, storage, location, key, bytes, now);
  return { key, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export async function readCloseoutOutput(
  store: Db,
  storage: EvidenceStorage,
  pointer: CloseoutOutputPointer,
): Promise<CloseoutOutput | null> {
  const file = await openEvidenceFile(store, storage, pointer.key);
  if (file === null) return null;
  const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
  if (sha256(bytes) !== pointer.sha256)
    throw new Error(`Closeout log ${pointer.key} does not match its sha256`);
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<CloseoutOutput>;
  return { stdout: parsed.stdout ?? "", stderr: parsed.stderr ?? "" };
}

export async function withCloseoutOutput<
  T extends CloseoutOutput & { output?: CloseoutOutputPointer | null },
>(store: Db, storage: EvidenceStorage, record: T): Promise<T> {
  if (!record.output) return record;
  try {
    const read = await readCloseoutOutput(store, storage, record.output);
    return read === null ? record : { ...record, ...read };
  } catch (error) {
    journalCaught(error, "closeout-logs.withCloseoutOutput", null);
    return record;
  }
}

export async function moveCloseoutOutput(
  store: Db,
  storage: EvidenceStorage,
  row: StoredCloseoutOutput,
  now: number,
): Promise<boolean> {
  const location = { itemId: row.itemId, headCommit: row.head, checkId: row.checkId };
  const pointer = await storeCloseoutOutput(store, storage, location, row, now);
  const read = await readCloseoutOutput(store, storage, pointer).catch((error: unknown) => {
    journalCaught(error, "closeout-logs.moveCloseoutOutput.verify", row.itemId);
    return null;
  });
  if (read?.stdout !== row.stdout || read.stderr !== row.stderr) {
    await removeEvidenceFile(store, storage, pointer.key);
    throw new Error(`Closeout log ${pointer.key} did not read back as written`);
  }
  if (await store.transaction((q) => pointCloseoutOutputSteps(q, row, pointer))) return true;
  await removeEvidenceFile(store, storage, pointer.key);
  return false;
}

export function uploadLocalCloseoutLogs(store: Db, storage: EvidenceStorage) {
  return uploadLocalEvidence(store, storage, Date.now, localCloseoutLogFiles);
}
