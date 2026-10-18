import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ulid } from "../core";
import { getRun, insertEvidence, type EvidenceRecord } from "../db";
import { EVIDENCE_CAPS, evidenceCap, sniffEvidence, type EvidenceCaps } from "./media";

export type EvidenceRejection = "type" | "size" | "input";

export class EvidenceRejected extends Error {
  readonly reason: EvidenceRejection;
  constructor(reason: EvidenceRejection, message: string) {
    super(message);
    this.name = "EvidenceRejected";
    this.reason = reason;
  }
}

export type StoreEvidenceInput = {
  db: Database;
  dir: string;
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  displayName: string;
  headCommit: string;
  bytes: Uint8Array;
  now?: number;
  caps?: EvidenceCaps;
};

const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function storeEvidence(input: StoreEvidenceInput): EvidenceRecord {
  const caps = input.caps ?? EVIDENCE_CAPS;
  const size = input.bytes.byteLength;
  if (size === 0) throw new EvidenceRejected("type", "The evidence file is empty.");
  if (size > Math.max(caps.video, caps.image))
    throw new EvidenceRejected("size", "The evidence file is over the size cap.");
  const mediaType = sniffEvidence(input.bytes);
  if (mediaType === null)
    throw new EvidenceRejected(
      "type",
      "Evidence must be a WebM or MP4 video, or a PNG, JPEG or WebP image.",
    );
  if (size > evidenceCap(mediaType, caps))
    throw new EvidenceRejected("size", "The evidence file is over the size cap.");
  if (!Number.isInteger(input.attempt) || input.attempt < 1)
    throw new EvidenceRejected("input", "The attempt must be a positive integer.");
  if (!validCheckId(input.checkId)) throw new EvidenceRejected("input", "The check id is invalid.");
  const headCommit = input.headCommit.toLowerCase();
  if (!HEAD.test(headCommit)) throw new EvidenceRejected("input", "The head commit is invalid.");
  if (getRun(input.db, input.runId)?.itemId !== input.itemId)
    throw new EvidenceRejected("input", "The run does not belong to the work item.");

  const now = input.now ?? Date.now();
  const record: EvidenceRecord = {
    id: ulid(now),
    itemId: input.itemId,
    runId: input.runId,
    checkId: input.checkId,
    attempt: input.attempt,
    mediaType,
    size,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    displayName: displayName(input.displayName),
    headCommit,
    createdAt: now,
  };
  ensureEvidenceDir(input.dir);
  const file = evidenceFile(input.dir, record.id);
  writePrivate(file, input.bytes);
  try {
    insertEvidence(input.db, record);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  return record;
}

export function evidenceFile(dir: string, id: string): string {
  return join(dir, id);
}

function ensureEvidenceDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("The evidence directory is not a directory.");
  chmodSync(dir, 0o700);
}

function writePrivate(file: string, bytes: Uint8Array): void {
  const temporary = `${file}.partial`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, file);
}

function withoutControls(text: string): string {
  return [...text].filter((char) => char >= " " && char !== "\u007f").join("");
}

function validCheckId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && withoutControls(id) === id;
}

function displayName(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) ?? "";
  const clean = withoutControls(leaf).trim().slice(0, 200);
  return clean.length > 0 && clean !== "." && clean !== ".." ? clean : "evidence";
}
