import { closeoutCheckRunsSteps, stageHistorySteps, type Db, type StageMarkRow } from "../db";

export const STAGE_WINDOW_MAX_MS = 30 * 24 * 60 * 60_000;

type Span = { start: number; end: number };
type Counts = Record<string, number>;
type StageTotals = ReturnType<typeof emptyTotals>;
type MergeWait = StageTotals["mergeWaitMs"];

const STAGE_KEYS: Record<string, keyof StageTotals["stagesMs"]> = {
  queued: "queued",
  running: "running",
  verifying: "verifying",
  awaiting_input: "awaitingInput",
  merge_queue: "mergeQueue",
};
const MARK_LABEL = {
  review_started: "review",
  review_ended: "unclassified",
  enqueued: "githubQueue",
} as const;
const MARK_ORDER = Object.keys(MARK_LABEL);

function emptyTotals() {
  return {
    stagesMs: { queued: 0, running: 0, verifying: 0, awaitingInput: 0, mergeQueue: 0 },
    waitingForPersonMs: 0,
    mergeWaitMs: { review: 0, githubQueue: 0, unclassified: 0 },
    turns: 0,
    closeoutRounds: 0,
  };
}

function add(target: Counts, source: Counts): void {
  for (const key of Object.keys(target)) target[key]! += source[key]!;
}

function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function mergeWait(span: Span, marks: readonly StageMarkRow[], window: Span): MergeWait {
  const times = { review: 0, githubQueue: 0, unclassified: 0 };
  let label: keyof MergeWait = "unclassified";
  let start = span.start;
  const ordered = [...marks].sort(
    (a, b) => a.at - b.at || MARK_ORDER.indexOf(a.kind) - MARK_ORDER.indexOf(b.kind),
  );
  for (const mark of ordered) {
    if (mark.at < span.start || mark.at >= span.end) continue;
    times[label] += overlap({ start, end: mark.at }, window);
    label = MARK_LABEL[mark.kind];
    start = mark.at;
  }
  times[label] += overlap({ start, end: span.end }, window);
  return times;
}

function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const low = sorted[Math.floor(at)]!;
  return Math.round(low + (sorted[Math.ceil(at)]! - low) * (at - Math.floor(at)));
}

export async function readStageTimes(
  db: Db,
  query: { from: number; to: number; now: number; repository?: { owner: string; repo: string } },
) {
  const [history, checkRows] = await Promise.all([
    db.run((q) => stageHistorySteps(q, query)),
    db.run((q) => closeoutCheckRunsSteps(q, query)),
  ]);
  const window = { start: query.from, end: query.to };
  const until = Math.min(query.to, query.now);
  const total = emptyTotals();
  const items = history.items.map((row) => {
    const item = {
      itemId: row.id,
      identifier: row.identifier,
      title: row.title,
      repository: row.owner && row.repo ? `${row.owner}/${row.repo}` : null,
      ...emptyTotals(),
      waitingForPerson: [] as { questionId: string; reason: string | null; ms: number }[],
    };
    const events = history.events.filter((event) => event.itemId === row.id);
    const marks = history.marks.filter((mark) => mark.itemId === row.id);
    const waiting: Span[] = [];
    const visit = (state: string, span: Span) => {
      const key = STAGE_KEYS[state];
      if (!key || span.end <= span.start) return;
      item.stagesMs[key] += overlap(span, window);
      if (key === "awaitingInput") waiting.push(span);
      if (key === "mergeQueue") add(item.mergeWaitMs, mergeWait(span, marks, window));
    };
    if (events.length === 0) visit(row.state, { start: row.createdAt, end: until });
    events.forEach((event, index) => {
      if (index === 0) visit(event.fromState, { start: row.createdAt, end: event.at });
      visit(event.toState, { start: event.at, end: events[index + 1]?.at ?? until });
      if (event.at < query.from) return;
      if (event.toState === "running") item.turns += 1;
      if (event.toState === "verifying") item.closeoutRounds += 1;
    });
    let counted = -Infinity;
    const asks = history.questions.filter((question) => question.itemId === row.id);
    for (const ask of asks.toSorted((a, b) => a.createdAt - b.createdAt)) {
      const start = Math.max(ask.createdAt, counted);
      const end = Math.max(start, ask.answeredAt ?? ask.cancelledAt ?? until);
      counted = end;
      const ms = waiting.reduce(
        (sum, span) =>
          sum +
          overlap({ start: Math.max(span.start, start), end: Math.min(span.end, end) }, window),
        0,
      );
      if (ms > 0) item.waitingForPerson.push({ questionId: ask.id, reason: ask.reason, ms });
      item.waitingForPersonMs += ms;
    }
    add(total.stagesMs, item.stagesMs);
    add(total.mergeWaitMs, item.mergeWaitMs);
    total.waitingForPersonMs += item.waitingForPersonMs;
    total.turns += item.turns;
    total.closeoutRounds += item.closeoutRounds;
    return item;
  });
  const runs = Map.groupBy(checkRows, (row) => row.stepId);
  const checks = [...runs]
    .map(([checkId, rows]) => {
      const sorted = rows.map((run) => run.finishedAt! - run.startedAt!).sort((a, b) => a - b);
      return {
        checkId,
        runs: rows.length,
        timeouts: rows.filter((run) => run.timedOut === 1).length,
        medianMs: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
      };
    })
    .sort((a, b) => b.medianMs - a.medianMs || a.checkId.localeCompare(b.checkId));
  return { items, total, checks };
}
