import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import {
  getEvidence,
  getWorkItem,
  openVisualReviewFiles,
  workspaceMember,
  type VisualReviewMark,
} from "../db";
import { sniffMedia } from "./media";
import { EVIDENCE_LIMITS, evidencePath } from "./store";
import { ulid } from "./ulid";

export const VISUAL_REVIEW_CHANGES_PATH = "/api/visual-review-changes";

const MAX_NOTE = 10_000;
const MAX_MARKS = 20;
const NO_NOTE = "See the marks on the screenshots.";

export type VisualReviewChanges = (input: {
  questionId: string;
  answeredBy: string;
  note: string;
  marks: readonly VisualReviewMark[];
}) => Promise<"answered" | "forbidden" | "rejected">;

export type VisualReviewChangesOptions = {
  db: Database;
  root: string;
  principal: { workspaceId: string; userId: string } | undefined;
  sessionIds: readonly string[] | undefined;
  submit: VisualReviewChanges;
  now?: () => number;
};

export async function handleVisualReviewChanges(
  request: Request,
  options: VisualReviewChangesOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== VISUAL_REVIEW_CHANGES_PATH) return null;
  const { db, principal, sessionIds } = options;
  if (principal === undefined || sessionIds === undefined)
    return Response.json({ error: "Sign in to Paws." }, { status: 401 });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const length = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isSafeInteger(length) || length > MAX_MARKS * EVIDENCE_LIMITS.image)
    return Response.json({ error: "The marked screenshots are too large." }, { status: 413 });
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Send the review as a form." }, { status: 400 });
  }
  const questionId = form.get("questionId");
  const note = form.get("note") ?? "";
  if (typeof questionId !== "string" || typeof note !== "string" || note.length > MAX_NOTE)
    return Response.json({ error: "Send a question and a note." }, { status: 400 });
  const member = workspaceMember(db, principal.workspaceId, principal.userId);
  if (!member?.active || member.role === "observer" || !member.linearUserId)
    return Response.json({ error: "Your membership can't answer reviews." }, { status: 403 });
  const review = openVisualReviewFiles(db, questionId);
  const item = review ? getWorkItem(db, review.itemId) : null;
  if (!review || item?.sessionKey == null || !sessionIds.includes(item.sessionKey))
    return Response.json(
      { error: "This review is no longer waiting. Refresh the run." },
      { status: 409 },
    );
  const files: { evidenceId: string; bytes: Uint8Array }[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("mark:")) continue;
    const evidenceId = key.slice("mark:".length);
    if (
      typeof value === "string" ||
      !review.evidenceIds.includes(evidenceId) ||
      files.some((file) => file.evidenceId === evidenceId) ||
      !getEvidence(db, evidenceId)?.mediaType.startsWith("image/") ||
      value.size > EVIDENCE_LIMITS.image
    )
      return Response.json({ error: "A mark doesn't match a screenshot." }, { status: 400 });
    const bytes = new Uint8Array(await value.arrayBuffer());
    if (sniffMedia(bytes.subarray(0, 64)) !== "image/png")
      return Response.json({ error: "Marked screenshots must be PNG." }, { status: 400 });
    files.push({ evidenceId, bytes });
  }
  if (files.length === 0 && note.trim() === "")
    return Response.json(
      { error: "Draw on a screenshot or write what to change." },
      { status: 400 },
    );
  const now = (options.now ?? Date.now)();
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  await chmod(options.root, 0o700);
  const marks: VisualReviewMark[] = [];
  try {
    for (const file of files) {
      const id = ulid(now);
      await writeFile(evidencePath(options.root, id), file.bytes, { flag: "wx", mode: 0o600 });
      marks.push({
        id,
        questionId,
        evidenceId: file.evidenceId,
        sizeBytes: file.bytes.byteLength,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        createdAt: now,
      });
    }
    const result = await options.submit({
      questionId,
      answeredBy: member.linearUserId,
      note: note.trim() || NO_NOTE,
      marks,
    });
    if (result === "answered") return Response.json({ ok: true, marks: marks.length });
    await removeMarks(options.root, marks);
    return result === "forbidden"
      ? Response.json(
          {
            error:
              "Only the person who delegated this issue or the Linear project's lead can request changes.",
          },
          { status: 403 },
        )
      : Response.json(
          { error: "This review is no longer waiting. Refresh the run." },
          { status: 409 },
        );
  } catch (error) {
    await removeMarks(options.root, marks);
    throw error;
  }
}

async function removeMarks(root: string, marks: readonly VisualReviewMark[]): Promise<void> {
  await Promise.all(marks.map((mark) => rm(evidencePath(root, mark.id), { force: true })));
}
