import { retroTranscriptRowsSteps, retroUntranscribedTurnsSteps, type Db } from "../db";

const RETRO_TRANSCRIPT_RUN_LIMIT = 2_000;
export const RETRO_TRANSCRIPT_PROMPT_CHARS = 40_000;
const RETRO_TRANSCRIPT_SECTION_BYTES = 2 * 1024 * 1024;
const TOP_FAILED_TOOLS = 5;
const FAILURE_CHARS = 300;
const MESSAGE_CHARS = 600;
const MESSAGE_LIMIT = 10;
const MESSAGE_HOLD_CHARS = 20_000;

export type RetroTranscriptReader = {
  download(runId: string, generation: number): Promise<Uint8Array>;
};

type RetroTranscriptSummary = {
  agent: string;
  model: string | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
  turns: number;
  stopReasons: Record<string, number>;
  toolCalls: number;
  failedTools: number;
  topFailedTools: { title: string; count: number; excerpt: string }[];
  blockedWaits: number;
  runCloseoutCalls: number;
  getCloseoutCalls: number;
  lastMessages: { at: number | null; before: "question" | "failure"; text: string }[];
};

type RetroTranscriptEntry = {
  runId: string;
  generation: number | null;
  itemId: string;
  identifier: string;
  kind: string;
  at: number | null;
  sizeBytes: number;
  status: string;
  summary: RetroTranscriptSummary | null;
};

export type RetroTranscriptSection = {
  entries: RetroTranscriptEntry[];
  runsNotRead: number;
  trimmed: number;
  note: string | null;
};

type RetroTranscriptRun = {
  id: string;
  itemId: string;
  kind: string;
  agent: string;
  createdAt: number;
};

type Clip = (text: string, limit: number) => string;
type Tool = { title: string; input: string; failed: boolean; output: string };

const text = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

function summarizeRetroTranscript(
  bytes: Uint8Array,
  agent: string,
  clip: Clip,
): RetroTranscriptSummary {
  const tools = new Map<string, Tool>();
  const stopReasons: Record<string, number> = {};
  const lastMessages: RetroTranscriptSummary["lastMessages"] = [];
  let model: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let turns = 0;
  let message = "";
  let inMessage = false;
  const remember = (at: number | null, before: "question" | "failure") => {
    if (message.trim().length === 0) return;
    lastMessages.push({ at, before, text: clip(message, MESSAGE_CHARS) });
    if (lastMessages.length > MESSAGE_LIMIT) lastMessages.shift();
  };
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (line.trim().length === 0) continue;
    let record: { t?: unknown; event?: Record<string, unknown> };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof record.t === "string" ? Date.parse(record.t) : Number.NaN;
    const when = Number.isFinite(at) ? at : null;
    if (when !== null) {
      first = first === null ? when : Math.min(first, when);
      last = last === null ? when : Math.max(last, when);
    }
    const event = record.event ?? {};
    const update = (event.update ?? {}) as Record<string, unknown>;
    const chunk =
      event.type === "session_update" &&
      update.sessionUpdate === "agent_message_chunk" &&
      typeof (update.content as { text?: unknown } | undefined)?.text === "string";
    if (chunk) {
      const part = (update.content as { text: string }).text;
      message = (inMessage ? message + part : part).slice(0, MESSAGE_HOLD_CHARS);
      inMessage = true;
      continue;
    }
    if (event.type === "session_update" && update.sessionUpdate === "agent_thought_chunk") continue;
    inMessage = false;
    if (event.type === "session_started") {
      const identity = event.identity as { model?: unknown } | undefined;
      if (typeof identity?.model === "string" && identity.model.length > 0)
        model = clip(identity.model, 120);
    } else if (event.type === "prompt_complete") {
      turns += 1;
      const reason = clip(text(event.stopReason), 60);
      stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
    } else if (event.type === "ask_team" && event.phase === "asked") remember(when, "question");
    else if (event.type === "error") remember(when, "failure");
    else if (
      event.type === "session_update" &&
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      typeof update.toolCallId === "string"
    ) {
      const tool = tools.get(update.toolCallId) ?? {
        title: "",
        input: "",
        failed: false,
        output: "",
      };
      if (typeof update.title === "string" && update.title.length > 0) tool.title = update.title;
      if (update.rawInput !== undefined) tool.input = text(update.rawInput).slice(0, 4_000);
      const output = [
        update.rawOutput === undefined ? "" : text(update.rawOutput),
        ...(Array.isArray(update.content) ? update.content : []).map((part) =>
          text((part as { content?: { text?: unknown } }).content?.text ?? ""),
        ),
      ]
        .join("\n")
        .trim();
      if (output.length > 0) tool.output = output.slice(0, 4_000);
      if (update.status === "failed") tool.failed = true;
      tools.set(update.toolCallId, tool);
    }
  }
  const failed = [...tools.values()].filter((tool) => tool.failed);
  const byTitle = new Map<string, { count: number; output: string }>();
  for (const tool of failed) {
    const title = clip(tool.title || "untitled tool", 120);
    const entry = byTitle.get(title) ?? { count: 0, output: tool.output };
    entry.count += 1;
    if (entry.output.length === 0) entry.output = tool.output;
    byTitle.set(title, entry);
  }
  const titled = (pattern: RegExp) =>
    [...tools.values()].filter((tool) => pattern.test(tool.title)).length;
  return {
    agent,
    model,
    firstEventAt: first,
    lastEventAt: last,
    turns,
    stopReasons,
    toolCalls: tools.size,
    failedTools: failed.length,
    topFailedTools: [...byTitle.entries()]
      .sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, TOP_FAILED_TOOLS)
      .map(([title, entry]) => ({
        title,
        count: entry.count,
        excerpt: clip(entry.output, FAILURE_CHARS),
      })),
    blockedWaits: failed.filter((tool) => /\b(sleep|pgrep)\b/.test(`${tool.title}\n${tool.input}`))
      .length,
    runCloseoutCalls: titled(/run_closeout/),
    getCloseoutCalls: titled(/get_closeout/),
    lastMessages,
  };
}

const iso = (value: number | null) => (value === null ? "unknown" : new Date(value).toISOString());

function transcriptIndexLine(entry: RetroTranscriptEntry): string {
  return `- run:${entry.runId}${entry.generation === null ? "" : `#${entry.generation}`} ${entry.identifier} ${entry.kind} ${iso(entry.at)} ${entry.sizeBytes} bytes ${entry.status}`;
}

function transcriptSummaryBlock(entry: RetroTranscriptEntry): string {
  const s = entry.summary;
  if (s === null) return "";
  const reasons = Object.entries(s.stopReasons)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  return [
    `### run:${entry.runId}${entry.generation === null ? "" : `#${entry.generation}`} ${entry.identifier} ${entry.kind} ${s.agent} ${s.model ?? "unknown model"} ${iso(s.firstEventAt)} to ${iso(s.lastEventAt)}`,
    `turns ${s.turns} (${reasons || "no stop reason"}); tool calls ${s.toolCalls}; failed ${s.failedTools}; blocked waits ${s.blockedWaits}; run_closeout ${s.runCloseoutCalls}; get_closeout ${s.getCloseoutCalls}`,
    ...s.topFailedTools.map(
      (tool) =>
        `- failed ${JSON.stringify(tool.title)} x${tool.count}: ${JSON.stringify(tool.excerpt)}`,
    ),
    ...s.lastMessages.map(
      (last) =>
        `- last message before ${last.before} at ${iso(last.at)}: ${JSON.stringify(last.text)}`,
    ),
  ].join("\n");
}

const TRANSCRIPT_HEADER =
  "## transcripts\nOne index line per run, helper and retro turn in the window (id, item, kind, time, bytes, status). Summaries count turns, tool calls, failed tools, blocked waits (failed sleep or pgrep commands) and Closeout calls; their text is redacted. Entries marked missing, unreadable or not stored by design have no transcript evidence.";

function indexView(entries: readonly RetroTranscriptEntry[], room: number): string[] {
  const index = entries.map(transcriptIndexLine);
  if (index.reduce((sum, line) => sum + line.length + 1, 0) <= room) return index;
  const counts = new Map<string, Record<string, number>>();
  for (const entry of entries) {
    const tally = counts.get(entry.identifier) ?? {};
    const status = entry.status.split(":")[0]!;
    tally.runs = (tally.runs ?? 0) + 1;
    tally[status] = (tally[status] ?? 0) + 1;
    counts.set(entry.identifier, tally);
  }
  return [
    `Index lines for ${index.length} runs do not fit this view; the digest keeps every one. Per item:`,
    ...[...counts].map(
      ([identifier, c]) =>
        `- ${identifier}: ${c.runs} runs, ${c.available ?? 0} available, ${c.missing ?? 0} missing, ${c.unreadable ?? 0} unreadable, ${c["not stored by design"] ?? 0} not stored by design`,
    ),
  ];
}

const NOT_STORED = "not stored by design: helper and retro turns keep no runner transcript";

export function boundRetroTranscripts(
  entries: RetroTranscriptEntry[],
  runsNotRead: number,
  maxChars = RETRO_TRANSCRIPT_PROMPT_CHARS,
  maxBytes = RETRO_TRANSCRIPT_SECTION_BYTES,
): RetroTranscriptSection {
  const reserve = 400;
  let chars =
    TRANSCRIPT_HEADER.length +
    indexView(entries, maxChars - TRANSCRIPT_HEADER.length - reserve).reduce(
      (sum, line) => sum + line.length + 1,
      0,
    );
  let bytes = Buffer.byteLength(
    JSON.stringify(entries.map((entry) => ({ ...entry, summary: null }))),
  );
  const keep = new Set<RetroTranscriptEntry>();
  const ranked = entries
    .filter((entry) => entry.summary !== null)
    .sort((a, b) => b.summary!.failedTools - a.summary!.failedTools);
  for (const entry of ranked) {
    const blockChars = transcriptSummaryBlock(entry).length + 1;
    const blockBytes = Buffer.byteLength(JSON.stringify(entry.summary)) + 1;
    if (chars + blockChars + reserve > maxChars || bytes + blockBytes + reserve > maxBytes) break;
    keep.add(entry);
    chars += blockChars;
    bytes += blockBytes;
  }
  const trimmed = ranked.length - keep.size;
  const notes = [
    trimmed > 0
      ? `Summaries for ${trimmed} runs were trimmed to their index line; the runs with the most failed tools kept theirs.`
      : "",
    runsNotRead > 0
      ? `${runsNotRead} runs past the ${RETRO_TRANSCRIPT_RUN_LIMIT}-run limit were not read.`
      : "",
  ].filter((note) => note.length > 0);
  return {
    entries: entries.map((entry) => (keep.has(entry) ? entry : { ...entry, summary: null })),
    runsNotRead,
    trimmed,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

export function renderRetroTranscripts(section: RetroTranscriptSection, maxChars: number): string {
  const lines = [TRANSCRIPT_HEADER];
  let size = TRANSCRIPT_HEADER.length;
  const tail = section.note ?? "";
  const all = [
    ...indexView(section.entries, maxChars - size - tail.length - 240),
    ...section.entries.map(transcriptSummaryBlock).filter((block) => block.length > 0),
  ];
  let omitted = 0;
  for (const line of all) {
    if (omitted > 0 || size + line.length + tail.length + 120 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (omitted > 0) lines.push(`${omitted} transcript lines are omitted from this view.`);
  if (tail.length > 0) lines.push(tail);
  return lines.join("\n");
}

export async function collectRetroTranscripts(
  store: Db,
  input: {
    workspaceId: string;
    retroId: string;
    repositories: readonly string[];
    items: readonly { itemId: string; identifier: string }[];
    from: number;
    to: number;
    runs: readonly RetroTranscriptRun[];
    reader: RetroTranscriptReader | undefined;
    clip: Clip;
  },
): Promise<RetroTranscriptSection> {
  const ordered = input.items.flatMap((item) =>
    input.runs.filter((run) => run.itemId === item.itemId).map((run) => ({ run, item })),
  );
  const runs = ordered.slice(0, RETRO_TRANSCRIPT_RUN_LIMIT);
  const itemIds = input.items.map((item) => item.itemId);
  const [rows, turns] = await store.run(function* (q) {
    return [
      yield* retroTranscriptRowsSteps(
        q,
        input.workspaceId,
        runs.map(({ run }) => run.id),
      ),
      yield* retroUntranscribedTurnsSteps(q, { ...input, itemIds }),
    ] as const;
  });
  const entries: RetroTranscriptEntry[] = [];
  const notStored = { sizeBytes: 0, generation: null, status: NOT_STORED, summary: null };
  for (const item of input.items) {
    const base = { itemId: item.itemId, identifier: item.identifier };
    for (const { run } of runs.filter((entry) => entry.item === item)) {
      const own = rows.filter((row) => row.runId === run.id);
      const at = run.createdAt;
      if (own.length === 0)
        entries.push({
          ...base,
          runId: run.id,
          generation: null,
          kind: run.kind,
          at,
          sizeBytes: 0,
          status: "missing",
          summary: null,
        });
      for (const row of own) {
        const entry = {
          ...base,
          runId: run.id,
          generation: row.generation,
          kind: row.commandKind === null ? run.kind : `${run.kind}/${row.commandKind}`,
          at,
          sizeBytes: row.sealedSize ?? row.sizeBytes,
        };
        try {
          if (input.reader === undefined) throw new Error("transcript storage is unavailable");
          const bytes = await input.reader.download(run.id, row.generation);
          entries.push({
            ...entry,
            status: "available",
            summary: summarizeRetroTranscript(bytes, run.agent, input.clip),
          });
        } catch (error) {
          const reason = input.clip(error instanceof Error ? error.message : String(error), 200);
          entries.push({ ...entry, status: `unreadable: ${reason}`, summary: null });
        }
      }
    }
    for (const helper of turns.helpers.filter((entry) => entry.itemId === item.itemId))
      entries.push({
        ...base,
        ...notStored,
        runId: helper.id,
        kind: `helper/${helper.purpose ?? "session"}`,
        at: helper.at,
      });
  }
  for (const retro of turns.retros)
    entries.push({
      ...notStored,
      runId: retro.commandId,
      itemId: "",
      identifier: `retro:${retro.retroId}`,
      kind: "retro",
      at: retro.at,
    });
  return boundRetroTranscripts(entries, ordered.length - runs.length);
}
