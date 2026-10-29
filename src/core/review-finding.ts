/** A review finding Paws keeps after its item merges: open, filed in Linear, dismissed, or gone. */
export type ReviewFindingStatus = "open" | "filed" | "dismissed" | "gone";

/** The file and lines a finding location names. `lines` is empty when it names no line. */
export type FindingPlace = { path: string; lines: string; firstLine: number | null };

/**
 * `src/a.ts:12` is lines `12`, `src/a.ts:12-20` is `12-20`, and `src/a.ts:12:5` is `12` (the
 * column is dropped). A location without a line is the whole text as its path.
 */
export function findingPlace(location: string): FindingPlace {
  const trimmed = location.trim();
  const match = /^(.+?):(\d+)(?:-(\d+)|:\d+)?$/.exec(trimmed);
  const path = cleanPath(match ? match[1]! : trimmed);
  if (!match) return { path, lines: "", firstLine: null };
  const first = Number(match[2]);
  const last = match[3] === undefined ? first : Number(match[3]);
  return {
    path,
    lines: last > first ? `${first}-${last}` : String(first),
    firstLine: first,
  };
}

/** Text compared case- and spacing-blind, without trailing punctuation. */
export function normalizeFindingText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!;:,\s]+$/, "");
}

/**
 * The key two reports of one finding share: repository, path, line range and normalized text.
 * The Findings page keeps one row per key, and filing an issue from a finding uses it to find
 * that row.
 */
export function reviewFindingKey(input: {
  /** `owner/repo`. */
  repository: string;
  location: string;
  text: string;
}): string {
  const place = findingPlace(input.location);
  return JSON.stringify([
    input.repository.trim().toLowerCase(),
    place.path,
    place.lines,
    normalizeFindingText(input.text),
  ]);
}

function cleanPath(path: string): string {
  const bare = path.trim().replace(/^`|`$/g, "").trim();
  return bare.startsWith("./") ? bare.slice(2) : bare;
}
