import type { Database } from "bun:sqlite";
import { getRetro, readRetroArtifact, workItemSessionKeys, type Retro } from "../db";
import { memberRepositories } from "../improvements";
import type { WorkspacePrincipal } from "../workspace";
import type { RetroDigest } from "./digest";

type EvidenceSource = { itemId: string; identifier: string; repository: string };
type DigestIndex = {
  records: Map<string, EvidenceSource>;
  itemIds: string[];
  coverage: RetroDigestSize;
};

/** How much the frozen digest holds: sessions, counted records and context-only records. */
export type RetroDigestSize = { sessions: number; counted: number; context: number };

export type RetroReaderAccess = {
  retro: Retro;
  full: boolean;
  readable: ReadonlySet<string>;
  repositories: string[];
  sources: ReadonlyMap<string, EvidenceSource>;
  digest: RetroDigestSize;
};

const CACHE_LIMIT = 16;
const indexes = new Map<string, DigestIndex>();

function digestIndex(db: Database, root: string, retro: Retro): DigestIndex | null {
  if (retro.digestSha256 === null)
    return { records: new Map(), itemIds: [], coverage: { sessions: 0, counted: 0, context: 0 } };
  const key = `${retro.id}:${retro.digestSha256}`;
  const cached = indexes.get(key);
  if (cached) return cached;
  const stored = readRetroArtifact(db, root, retro.id, "digest");
  if (!stored.ok || stored.artifact.sha256 !== retro.digestSha256) return null;
  let digest: RetroDigest;
  try {
    digest = JSON.parse(new TextDecoder().decode(stored.bytes)) as RetroDigest;
  } catch {
    return null;
  }
  const index: DigestIndex = {
    records: new Map(
      digest.records.map((record) => [
        record.evidenceId,
        { itemId: record.itemId, identifier: record.identifier, repository: record.repository },
      ]),
    ),
    itemIds: [
      ...new Set([
        ...digest.sessions.map((session) => session.itemId),
        ...digest.records.map((record) => record.itemId),
      ]),
    ],
    coverage: {
      sessions: digest.sessions.length,
      counted: digest.records.filter((record) => record.scope !== "context").length,
      context: digest.records.filter((record) => record.scope === "context").length,
    },
  };
  if (indexes.size >= CACHE_LIMIT) indexes.delete(indexes.keys().next().value!);
  indexes.set(key, index);
  return index;
}

export function retroReaderAccess(
  db: Database,
  root: string,
  principal: WorkspacePrincipal,
  sessionIds: readonly string[],
  retroId: string,
): RetroReaderAccess | null {
  const retro = getRetro(db, retroId);
  if (retro === null || retro.workspaceId !== principal.workspaceId) return null;
  const index = digestIndex(db, root, retro);
  if (index === null) return null;
  const accessible = new Set(
    memberRepositories(db, principal.workspaceId, principal.userId).map((name) =>
      name.toLowerCase(),
    ),
  );
  const sessions = new Map(
    workItemSessionKeys(db, index.itemIds).map((row) => [row.id, row.sessionKey]),
  );
  const allowedSessions = new Set(sessionIds);
  const readableItem = (itemId: string) => {
    const key = sessions.get(itemId);
    return typeof key === "string" && allowedSessions.has(key);
  };
  const readable = new Set<string>();
  const repositories = new Set<string>();
  for (const [evidenceId, source] of index.records)
    if (accessible.has(source.repository.toLowerCase()) && readableItem(source.itemId)) {
      readable.add(evidenceId);
      repositories.add(source.repository.toLowerCase());
    }
  const full =
    retro.repositories.every((name) => accessible.has(name.toLowerCase())) &&
    index.itemIds.every(readableItem);
  return {
    retro,
    full,
    readable,
    repositories: full ? retro.repositories : [...repositories].sort(),
    sources: index.records,
    digest: index.coverage,
  };
}
