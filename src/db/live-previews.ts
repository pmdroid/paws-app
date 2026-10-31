import type { Database } from "bun:sqlite";
import { PreviewReadySchema, type PreviewReady } from "../runner-protocol";

export function saveLivePreview(
  db: Database,
  itemId: string,
  questionId: string,
  ready: PreviewReady,
): void {
  db.run("INSERT INTO live_preview(id,item_id,question_id,ready) VALUES(?,?,?,?)", [
    ready.id,
    itemId,
    questionId,
    JSON.stringify(PreviewReadySchema.parse(ready)),
  ]);
}
export function getLivePreview(
  db: Database,
  id: string,
): {
  itemId: string;
  questionId: string;
  endedAt: number | null;
  ready: PreviewReady;
} | null {
  const row = db
    .query<{ itemId: string; questionId: string; endedAt: number | null; ready: string }, [string]>(
      "SELECT item_id AS itemId, question_id AS questionId, ended_at AS endedAt, ready FROM live_preview WHERE id=?",
    )
    .get(id);
  return row ? { ...row, ready: PreviewReadySchema.parse(JSON.parse(row.ready)) } : null;
}
/** Pending review metadata survives confirmation gaps; this does not authorize Accept. */
export function pendingLivePreviewForQuestion(
  db: Database,
  questionId: string,
  now = Date.now(),
): PreviewReady | null {
  const row = db
    .query<{ ready: string }, [string, number]>(
      "SELECT ready FROM live_preview WHERE question_id=? AND ended_at IS NULL AND json_extract(ready,'$.expiresAt')>?",
    )
    .get(questionId, now);
  return row ? PreviewReadySchema.parse(JSON.parse(row.ready)) : null;
}
export function livePreviewForQuestion(
  db: Database,
  questionId: string,
  now = Date.now(),
): PreviewReady | null {
  const row = db
    .query<{ ready: string }, [string, number]>(
      `SELECT p.ready FROM live_preview p JOIN live_preview_confirmation c ON c.question_id=p.question_id
     WHERE p.question_id=? AND p.ended_at IS NULL AND c.confirmed_until>?`,
    )
    .get(questionId, now);
  return row ? PreviewReadySchema.parse(JSON.parse(row.ready)) : null;
}
/** A short lease from the attached, confirmed execution, bounded by the original deadline. */
export function confirmLivePreview(db: Database, id: string, until: number): void {
  db.run(
    `INSERT INTO live_preview_confirmation(question_id,confirmed_until)
    SELECT question_id,MIN(?1,json_extract(ready,'$.expiresAt')) FROM live_preview
    WHERE id=?2 AND ended_at IS NULL
    ON CONFLICT(question_id) DO UPDATE SET confirmed_until=excluded.confirmed_until`,
    [until, id],
  );
}
export function detachLivePreview(db: Database, id: string): void {
  db.run(
    "DELETE FROM live_preview_confirmation WHERE question_id IN (SELECT question_id FROM live_preview WHERE id=?)",
    [id],
  );
}
export function detachAllLivePreviews(db: Database): void {
  db.run("DELETE FROM live_preview_confirmation");
}
export function endLivePreview(db: Database, id: string, now: number): void {
  db.run("UPDATE live_preview SET ended_at=COALESCE(ended_at,?) WHERE id=?", [now, id]);
}
export function livePreviewApprovals(db: Database, itemId: string, task: string) {
  return db
    .query<{ ready: string; decided_by: string; decided_at: number }, [string]>(
      `SELECT p.ready,a.decided_by,a.decided_at FROM live_preview p JOIN link_ask a ON a.question_id=p.question_id WHERE p.item_id=? AND a.decision='approve' AND a.closed_reason='decided' ORDER BY p.rowid`,
    )
    .all(itemId)
    .map((row) => {
      const preview = PreviewReadySchema.parse(JSON.parse(row.ready));
      return {
        task,
        checkId: preview.checkId,
        evidenceIds: [`preview:${preview.head}`],
        commit: preview.head,
        approvedBy: row.decided_by,
        approvedAt: new Date(row.decided_at).toISOString(),
      };
    });
}
/** The latest optional review gates publication; policy checks independently require their ids. */
export function unacceptedLivePreview(db: Database, itemId: string, head: string): boolean {
  const row = db
    .query<{ ready: string; decision: string | null }, [string]>(
      `SELECT p.ready,a.decision FROM live_preview p JOIN link_ask a ON a.question_id=p.question_id WHERE p.item_id=? ORDER BY p.rowid DESC LIMIT 1`,
    )
    .get(itemId);
  if (!row) return false;
  const preview = PreviewReadySchema.parse(JSON.parse(row.ready));
  return row.decision !== "approve" || preview.head !== head;
}

/** Explicit cancellation ends every preview owned by the item, even after disconnect. */
export function endItemLivePreviews(db: Database, itemId: string, now: number): void {
  db.run("UPDATE live_preview SET ended_at=COALESCE(ended_at,?) WHERE item_id=?", [now, itemId]);
  db.run(
    "DELETE FROM live_preview_confirmation WHERE question_id IN (SELECT question_id FROM live_preview WHERE item_id=?)",
    [itemId],
  );
}
