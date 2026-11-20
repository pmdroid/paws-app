import { asc, eq } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { lockSlackStatusSteps } from "./slack-threads";
import { ulid } from "./ulid";

export type SlackNoteKind = "observation" | "guess" | "decision";

export type SlackNoteSource = { repository: string; ref: string; commit: string };

export type SlackNoteInput = {
  kind: SlackNoteKind;
  text: string;
  repository: string | null;
  path: string | null;
  symbol: string | null;
  commit: string | null;
};

export type SlackNote = SlackNoteInput & {
  id: string;
  conversationId: string;
  workspaceId: string;
  requestId: string;
  authorUserId: string;
  sources: SlackNoteSource[];
  linearTeamIds: string[];
  createdAt: number;
};

const MAX_NOTES = 16;
const MAX_NOTE_BYTES = 1024;
const MAX_RUN_BYTES = 16384;

export function* addSlackNotesSteps(
  q: Q,
  input: {
    conversationId: string;
    workspaceId: string;
    requestId: string;
    authorUserId: string;
    sources: SlackNoteSource[];
    linearTeamIds: string[];
    notes: SlackNoteInput[];
    now: number;
  },
): Steps<number> {
  const { notes, now, ...run } = input;
  const kept: SlackNoteInput[] = [];
  let bytes = 0;
  for (const note of notes) {
    const size = Buffer.byteLength(note.text, "utf8");
    if (kept.length === MAX_NOTES) break;
    if (size === 0 || size > MAX_NOTE_BYTES || bytes + size > MAX_RUN_BYTES) continue;
    kept.push(note);
    bytes += size;
  }
  if (kept.length === 0) return 0;
  return yield* q.transaction(function* (tx) {
    const table = tx.t.slackThreadNote;
    yield* lockSlackStatusSteps(tx, `slack.notes:${run.requestId}`);
    const existing = yield* tx.one(
      tx.orm
        .select({ id: table.id })
        .from(table)
        .where(eq(table.requestId, run.requestId))
        .limit(1),
    );
    if (existing) return 0;
    const ids = kept.map(() => ulid(now)).sort();
    yield* tx.exec(
      tx.orm
        .insert(table)
        .values(kept.map((note, index) => ({ ...run, ...note, id: ids[index]!, createdAt: now }))),
    );
    return kept.length;
  });
}

export function* slackNotesSteps(q: Q, conversationId: string): Steps<SlackNote[]> {
  const table = q.t.slackThreadNote;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(table)
      .where(eq(table.conversationId, conversationId))
      .orderBy(asc(table.createdAt), asc(table.id)),
  );
  return rows.map((row) => ({
    ...row,
    kind: row.kind as SlackNoteKind,
    sources: row.sources as SlackNoteSource[],
    linearTeamIds: row.linearTeamIds as string[],
  }));
}
