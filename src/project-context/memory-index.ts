import type { ContextRecordRow } from "../db";
import type { ContextTopicView } from "./dream";
import {
  clip,
  manifestSource,
  oneLine,
  sourceLabel,
  type ContextManifest,
  type ContextRanking,
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
  readonly topics?: readonly ContextTopicView[];
  readonly appendix?: string;
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
  selection: Extract<ContextRanking, { status: "ok" }>,
  options: MemoryIndexOptions,
  count: (text: string) => number,
): { text: string; manifest: ContextManifest } | null {
  const topics = options.topics ?? [];
  const covered = new Set(topics.flatMap((topic) => topic.recordIds));
  const uncovered = selection.ranked.filter((row) => !covered.has(row.id));
  const ordered = [
    ...uncovered.filter((row) => row.classification === "decision"),
    ...uncovered.filter((row) => row.classification !== "decision"),
  ];
  const lines = [
    ...topics.map((topic) => `- Topic: ${clip(oneLine(topic.title), 80)} (id ${topic.id})`),
    ...ordered.map(indexLine),
  ];
  const budget = Math.min(options.tokens, selection.manifest.tokens.memoryBudget);
  const appendix = options.appendix ? count(`\n\n${options.appendix}`) : 0;
  const cost = (kept: number) =>
    count(render(lines.slice(0, kept), lines.length - kept, options.trailer)) + appendix;
  let kept = 0;
  while (kept < lines.length && cost(kept + 1) <= budget) kept++;
  if (kept === 0) return null;
  const text = render(lines.slice(0, kept), lines.length - kept, options.trailer);
  const indexed = ordered.slice(0, Math.max(0, kept - topics.length));
  const { manifest } = selection;
  const memoryUsed = cost(kept);
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
        memoryBudget: budget,
        memoryUsed,
        total: manifest.tokens.total - manifest.tokens.memoryUsed + memoryUsed,
      },
    },
  };
}
