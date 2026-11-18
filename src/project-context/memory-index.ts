import type { ContextRecordRow } from "../db";
import {
  clip,
  manifestSource,
  oneLine,
  sourceLabel,
  type ContextManifest,
  type ContextSelection,
} from "./select";

export const MEMORY_INDEX_LIMITS = {
  tokens: 1_000,
  lineChars: 140,
  decisionChars: 300,
} as const;

export const MEMORY_INDEX_HEADER =
  "Project memory index. Read an entry with recall({id}) or search with recall({query}).";

export type MemoryIndexOptions = {
  readonly tokens: number;
  readonly trailer: string;
};

function indexLine(row: ContextRecordRow): string {
  const body = oneLine(row.body);
  const text =
    row.classification === "decision" && body.length < MEMORY_INDEX_LIMITS.decisionChars
      ? body
      : clip(body, MEMORY_INDEX_LIMITS.lineChars);
  const label = row.correctedBy !== null ? `${row.classification}, corrected` : row.classification;
  return `- [${label}] ${text} (${sourceLabel(row)}, id ${row.id})`;
}

function render(lines: readonly string[], more: number, trailer: string): string {
  const header =
    more > 0
      ? `${MEMORY_INDEX_HEADER} ${more} more entries: use recall({query}).`
      : MEMORY_INDEX_HEADER;
  return [[header, ...lines].join("\n"), trailer].filter(Boolean).join("\n\n");
}

export function renderMemoryIndex(
  selection: Extract<ContextSelection, { status: "ok" }>,
  options: MemoryIndexOptions,
  count: (text: string) => number,
): { text: string; manifest: ContextManifest } {
  const ordered = [
    ...selection.ranked.filter((row) => row.classification === "decision"),
    ...selection.ranked.filter((row) => row.classification !== "decision"),
  ];
  const lines = ordered.map(indexLine);
  let kept = 0;
  while (
    kept < lines.length &&
    count(render(lines.slice(0, kept + 1), lines.length - kept - 1, options.trailer)) <=
      options.tokens
  )
    kept++;
  const text = render(lines.slice(0, kept), lines.length - kept, options.trailer);
  const indexed = ordered.slice(0, kept);
  const { manifest } = selection;
  const memoryUsed = count(text);
  return {
    text,
    manifest: {
      ...manifest,
      sources: indexed.map(manifestSource),
      references: [],
      summary: null,
      counts: {
        ...manifest.counts,
        selected: indexed.length,
        referenced: 0,
        suppressed: manifest.counts.candidates - indexed.length,
        summaryCovered: 0,
      },
      tokens: {
        ...manifest.tokens,
        memoryBudget: options.tokens,
        memoryUsed,
        total: manifest.tokens.total - manifest.tokens.memoryUsed + memoryUsed,
      },
    },
  };
}
