import { retroTranscriptInventorySteps, type Db } from "../db";

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

export type RetroTranscriptEntry = {
  runId: string;
  generation: number | null;
  itemId: string;
  identifier: string;
  kind: string;
  sizeBytes: number;
  status: string;
  summary: RetroTranscriptSummary | null;
};

export type RetroTranscriptSection = {
  entries: RetroTranscriptEntry[];
  runsNotRead: number;
  trimmed: number;
  indexOmitted: number;
  note: string | null;
};

type RetroTranscriptRun = {
  runId: string;
  itemId: string;
  identifier: string;
  kind: string;
  agent: string;
};

type Clip = (text: string, limit: number) => string;
type Tool = { title: string; input: string; failed: boolean; output: string };

const text = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

export function summarizeRetroTranscript(
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
  return `- run:${entry.runId}${entry.generation === null ? "" : `#${entry.generation}`} ${entry.identifier} ${entry.kind} ${entry.sizeBytes} bytes ${entry.status}`;
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
  "## transcripts\nOne index line per run transcript in the window (run, item, kind, bytes, status). Summaries count turns, tool calls, failed tools, blocked waits (failed sleep or pgrep commands) and Closeout calls; their text is redacted. A run marked missing or unreadable has no transcript evidence.";

export function boundRetroTranscripts(
  entries: RetroTranscriptEntry[],
  runsNotRead: number,
  maxChars = RETRO_TRANSCRIPT_PROMPT_CHARS,
  maxBytes = RETRO_TRANSCRIPT_SECTION_BYTES,
): RetroTranscriptSection {
  const reserve = 400;
  const failed = (entry: RetroTranscriptEntry) => entry.summary?.failedTools ?? 0;
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => failed(b.entry) - failed(a.entry) || a.index - b.index)
    .map(({ entry }) => entry);
  let chars = TRANSCRIPT_HEADER.length;
  let bytes = 0;
  const listed = new Set<RetroTranscriptEntry>();
  for (const entry of ranked) {
    const lineChars = transcriptIndexLine(entry).length + 1;
    const lineBytes = Buffer.byteLength(JSON.stringify({ ...entry, summary: null })) + 1;
    if (chars + lineChars + reserve > maxChars || bytes + lineBytes + reserve > maxBytes) break;
    listed.add(entry);
    chars += lineChars;
    bytes += lineBytes;
  }
  const keep = new Set<RetroTranscriptEntry>();
  for (const entry of ranked) {
    if (entry.summary === null || !listed.has(entry)) continue;
    const blockChars = transcriptSummaryBlock(entry).length + 1;
    const blockBytes = Buffer.byteLength(JSON.stringify(entry.summary)) + 1;
    if (chars + blockChars + reserve > maxChars || bytes + blockBytes + reserve > maxBytes) break;
    keep.add(entry);
    chars += blockChars;
    bytes += blockBytes;
  }
  const trimmed = entries.filter((entry) => entry.summary !== null).length - keep.size;
  const indexOmitted = entries.length - listed.size;
  const notes = [
    trimmed > 0
      ? `Summaries for ${trimmed} runs were trimmed to their index line; the runs with the most failed tools kept theirs.`
      : "",
    indexOmitted > 0
      ? `Index lines for ${indexOmitted} of ${entries.length} runs did not fit; the runs with the most failed tools are listed.`
      : "",
    runsNotRead > 0
      ? `${runsNotRead} runs past the ${RETRO_TRANSCRIPT_RUN_LIMIT}-run limit were not read.`
      : "",
  ].filter((note) => note.length > 0);
  return {
    entries: entries
      .filter((entry) => listed.has(entry))
      .map((entry) => (keep.has(entry) ? entry : { ...entry, summary: null })),
    runsNotRead,
    trimmed,
    indexOmitted,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

export function renderRetroTranscripts(section: RetroTranscriptSection, maxChars: number): string {
  const lines = [TRANSCRIPT_HEADER];
  let size = TRANSCRIPT_HEADER.length;
  const tail = section.note ?? "";
  const all = [
    ...section.entries.map(transcriptIndexLine),
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
    from: number;
    to: number;
    items: readonly { itemId: string; identifier: string }[];
    runs: readonly RetroTranscriptRun[];
    reader: RetroTranscriptReader | undefined;
    clip: Clip;
  },
): Promise<RetroTranscriptSection> {
  const runs = input.runs.slice(0, RETRO_TRANSCRIPT_RUN_LIMIT);
  const inventory = await store.run((q) =>
    retroTranscriptInventorySteps(q, {
      workspaceId: input.workspaceId,
      retroId: input.retroId,
      repositories: input.repositories,
      runIds: runs.map((run) => run.runId),
      itemIds: input.items.map((item) => item.itemId),
      from: input.from,
      to: input.to,
    }),
  );
  const missing = { sizeBytes: 0, status: "missing", summary: null };
  const entries: RetroTranscriptEntry[] = [];
  for (const item of input.items) {
    const base = { itemId: item.itemId, identifier: item.identifier };
    for (const run of runs.filter((entry) => entry.itemId === item.itemId)) {
      const commands = inventory.commands.filter((command) => command.runId === run.runId);
      const transcripts = inventory.transcripts.filter((row) => row.runId === run.runId);
      const known = new Set(commands.map((command) => command.id));
      if (commands.length === 0 && transcripts.length === 0)
        entries.push({ ...base, ...missing, runId: run.runId, generation: null, kind: run.kind });
      for (const command of [
        ...commands,
        ...transcripts
          .filter((row) => !known.has(row.commandId))
          .map((row) => ({ id: row.commandId, kind: "run", generation: row.generation })),
      ]) {
        const row = transcripts.find((entry) => entry.commandId === command.id);
        const kind = `${run.kind}/${command.kind}`;
        if (row === undefined) {
          entries.push({
            ...base,
            ...missing,
            runId: run.runId,
            generation: command.generation,
            kind,
          });
          continue;
        }
        const entry = {
          ...base,
          runId: run.runId,
          generation: row.generation,
          kind,
          sizeBytes: row.sealedSize ?? row.sizeBytes,
        };
        try {
          if (input.reader === undefined) throw new Error("transcript storage is unavailable");
          const bytes = await input.reader.download(run.runId, row.generation);
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
    for (const helper of inventory.helpers.filter((entry) => entry.itemId === item.itemId))
      entries.push({
        ...base,
        ...missing,
        runId: helper.id,
        generation: null,
        kind: `helper/${helper.purpose ?? "session"}`,
      });
  }
  for (const retro of inventory.retros)
    entries.push({
      ...missing,
      runId: retro.commandId,
      generation: retro.attempt,
      itemId: "",
      identifier: `retro:${retro.retroId}`,
      kind: "retro",
    });
  return boundRetroTranscripts(entries, input.runs.length - runs.length);
}
