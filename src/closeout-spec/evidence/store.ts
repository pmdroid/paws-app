import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Artifact, EvidenceRecord, EvidenceSnapshot, EvidenceStore } from "../types";
import {
  absoluteInside,
  evidenceRelative,
  itemDirectory,
  logRelative,
  relativePosix,
} from "./layout";
import { checkEvidence } from "./validate";

/**
 * Persistence for command and review records.
 *
 * The root matches a reference `.closeout/` directory: `evidence/<digest>/<head>/<item-id>/<attempt>.json`
 * and `logs/<digest>/<head>/<item-id>/<attempt>.log`. Digest directories are the 64 hex characters
 * after `sha256:`. Artifact paths are relative to this root, so a copy keeps the paths and hashes.
 * Attempt numbers are one sequence for a policy, head, and item, shared by every base and task.
 */
export type EvidenceStoreOptions = {
  /** Directory that contains `evidence/` and `logs/`. Tests pass a temporary directory. */
  root: string;
};

export type AttemptKey = {
  policyDigest: string;
  head: string;
  itemId: string;
};

export type LogWrite = AttemptKey & {
  attempt: number;
  body: string;
};

export type PawsEvidenceStore = EvidenceStore & {
  readonly root: string;
  /** Next attempt for this policy, head, and item, across every base and task. */
  nextAttempt(key: AttemptKey): Promise<number>;
  /** Write a command log and return its portable path and SHA-256. Does not overwrite. */
  writeLog(input: LogWrite): Promise<Artifact>;
};

export function createEvidenceStore(options: EvidenceStoreOptions): PawsEvidenceStore {
  const root = options.root;

  async function load(): Promise<EvidenceSnapshot> {
    const folder = join(root, "evidence");
    const walked = await walkJson(folder);
    if (walked.unreadable) {
      return { records: [], invalid: { message: "could not read the evidence directory" } };
    }
    const records: EvidenceRecord[] = [];
    let invalid: EvidenceSnapshot["invalid"];
    const files = [...walked.files].sort((left, right) =>
      relativePosix(root, left).localeCompare(relativePosix(root, right)),
    );
    for (const file of files) {
      const read = await readRecord(root, file);
      if (!read.ok) {
        invalid ??= { path: read.path, message: read.message };
        continue;
      }
      records.push(read.record);
    }
    return invalid ? { records, invalid } : { records };
  }

  async function nextAttempt(key: AttemptKey): Promise<number> {
    const numbers = new Set<number>(await filenameAttempts(root, key));
    const snapshot = await load();
    if (!snapshot.invalid) {
      for (const record of snapshot.records) {
        if (sameSlot(record, key)) numbers.add(record.attempt);
      }
    }
    return highest(numbers) + 1;
  }

  return {
    root,

    load,
    nextAttempt,

    async add(record: EvidenceRecord): Promise<void> {
      const checked = checkEvidence(record);
      if (!checked.ok) throw new Error(checked.message);

      const snapshot = await load();
      if (snapshot.invalid) throw new Error(snapshot.invalid.message);
      if (snapshot.records.some((existing) => sameAttemptIdentity(existing, record))) {
        throw new Error(`duplicate evidence attempt ${record.attempt} for ${record.itemId}`);
      }

      const attempt = await nextAttempt({
        policyDigest: record.policyDigest,
        head: record.head,
        itemId: record.itemId,
      });
      const stored = withAttempt(record, attempt);
      const again = checkEvidence(stored);
      if (!again.ok) throw new Error(again.message);

      const destination = absoluteInside(root, evidenceRelative(stored));
      await writeAtomic(destination, `${JSON.stringify(stored, null, 2)}\n`);
    },

    async writeLog(input: LogWrite): Promise<Artifact> {
      const path = logRelative(input);
      await writeAtomic(absoluteInside(root, path), input.body);
      return { path, sha256: sha256Text(input.body) };
    },
  };
}

function sameSlot(record: EvidenceRecord, key: AttemptKey): boolean {
  return (
    record.policyDigest === key.policyDigest &&
    record.head === key.head &&
    record.itemId === key.itemId
  );
}

function sameAttemptIdentity(existing: EvidenceRecord, incoming: EvidenceRecord): boolean {
  return (
    sameSlot(existing, incoming) &&
    existing.base === incoming.base &&
    existing.attempt === incoming.attempt
  );
}

function withAttempt(record: EvidenceRecord, attempt: number): EvidenceRecord {
  if (record.recordType === "command") return { ...record, attempt };
  return { ...record, attempt };
}

function highest(numbers: Set<number>): number {
  let max = 0;
  for (const value of numbers) if (value > max) max = value;
  return max;
}

async function filenameAttempts(root: string, key: AttemptKey): Promise<number[]> {
  let directory: string;
  try {
    directory = absoluteInside(root, itemDirectory(key));
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const numbers: number[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    const raw = match?.[1];
    if (raw === undefined) continue;
    const attempt = Number(raw);
    if (Number.isInteger(attempt)) numbers.push(attempt);
  }
  return numbers;
}

async function readRecord(
  root: string,
  file: string,
): Promise<{ ok: true; record: EvidenceRecord } | { ok: false; path: string; message: string }> {
  const path = relativePosix(root, file);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { ok: false, path, message: `evidence file ${path} is invalid` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, path, message: `evidence file ${path} is invalid` };
  }
  const checked = checkEvidence(parsed);
  if (!checked.ok)
    return { ok: false, path, message: `evidence file ${path} is invalid: ${checked.message}` };
  return { ok: true, record: checked.record };
}

async function walkJson(dir: string): Promise<{ files: string[]; unreadable: boolean }> {
  const files: string[] = [];
  const stack = [dir];
  let started = false;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (!started && isEnoent(error)) return { files, unreadable: false };
      return { files, unreadable: true };
    }
    started = true;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(absolute);
    }
  }
  return { files, unreadable: false };
}

/**
 * Write a temporary file in the destination directory, then rename it into place.
 * An existing attempt is left untouched.
 */
async function writeAtomic(destination: string, body: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(temporary, body, { flag: "wx" });
  try {
    if (await fileExists(destination)) {
      throw new Error(`evidence file already exists: ${basename(destination)}`);
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
