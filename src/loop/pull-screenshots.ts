import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readEvidenceBytes, type EvidenceStorage } from "../evidence";
import { listEvidenceSteps, sqliteDb, type StoredEvidence } from "../db";
import type { StoredEvidenceFiles } from "../github";
import { journalCaught } from "../journal";
import { rejectedEvidenceIdsSteps } from "../questions";
import { EVIDENCE_INLINE_LIMITS } from "./artifacts";

export const PULL_REQUEST_SCREENSHOT_LIMIT = 20;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function pullRequestScreenshotRows(
  db: Database,
  itemId: string,
): Promise<StoredEvidence[]> {
  const store = sqliteDb(db);
  const rejected = await store.run((q) => rejectedEvidenceIdsSteps(q, itemId));
  const latest = new Map<string, StoredEvidence>();
  for (const row of await store.run((q) => listEvidenceSteps(q, itemId)))
    latest.set(JSON.stringify([row.checkId, row.displayName]), row);
  return [...latest.values()]
    .filter(
      (row) =>
        !rejected.has(row.id) &&
        EXTENSIONS[row.mediaType] !== undefined &&
        row.sizeBytes <= EVIDENCE_INLINE_LIMITS.image,
    )
    .slice(0, PULL_REQUEST_SCREENSHOT_LIMIT);
}

export async function pullRequestScreenshots(input: {
  db: Database;
  itemId: string;
  storage: EvidenceStorage | undefined;
  owner: string;
  repo: string;
  store: (files: { bytes: Uint8Array; extension: string }[]) => Promise<StoredEvidenceFiles>;
  journal?: (line: string) => void;
}): Promise<string> {
  const rows = await pullRequestScreenshotRows(input.db, input.itemId);
  if (rows.length === 0 || input.storage === undefined) return "";
  const storage = input.storage;
  try {
    const files = await Promise.all(
      rows.map(async (row) => ({
        bytes: await readEvidence(input.db, storage, row),
        extension: EXTENSIONS[row.mediaType]!,
      })),
    );
    const stored = await input.store(files);
    const base = `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/blob/${stored.commit}`;
    return [
      "## Screenshots",
      ...rows.map((row, index) => {
        const label = row.displayName.replace(/[\\[\]]/g, "\\$&");
        return `![${label}](${base}/${stored.files[index]}?raw=true)`;
      }),
    ].join("\n\n");
  } catch (error) {
    journalCaught(
      error,
      "orchestrator.publishForMerge.screenshots",
      input.itemId,
      undefined,
      input.journal,
    );
    return "";
  }
}

async function readEvidence(
  db: Database,
  storage: EvidenceStorage,
  row: StoredEvidence,
): Promise<Uint8Array> {
  const bytes = await readEvidenceBytes(db, storage, row.id);
  if (
    bytes.byteLength !== row.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== row.sha256
  )
    throw new Error(`Evidence file ${row.id} failed its integrity check`);
  return bytes;
}
