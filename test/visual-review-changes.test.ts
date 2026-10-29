import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveVisualReviewMarks,
  syncWorkspaceMember,
  type VisualReviewMark,
} from "../src/db";
import {
  createEvidenceStore,
  evidencePath,
  handleEvidenceRequest,
  handleVisualReviewChanges,
  type VisualReviewChanges,
} from "../src/evidence";
import { openVisualReview } from "../src/questions";

const HEAD = "a".repeat(40);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const MARKED = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function harness(active = true) {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "ses_1" });
  const home = mkdtempSync(join(tmpdir(), "paws-review-marks-"));
  roots.push(home);
  const root = join(home, "evidence");
  const store = createEvidenceStore({ db, root });
  const shot = (name: string, source: Uint8Array) =>
    store.save({
      itemId: "item",
      runId: "run-1",
      checkId: "visual-proof",
      attempt: 1,
      displayName: name,
      headCommit: HEAD,
      source: new Blob([source]),
    });
  const first = await shot("first.png", PNG);
  const second = await shot("second.png", PNG);
  const other = await shot("other.png", PNG);
  const { question } = openVisualReview(db, {
    itemId: "item",
    runId: "run-1",
    sessionId: "ses_1",
    checkId: "visual-proof",
    evidenceIds: [first.id, second.id],
    headCommit: HEAD,
    now: 1,
  });
  const userId = putWorkspaceUser(db, {
    id: "user-ada",
    linearUserId: "delegator-1",
    name: "Ada",
    email: "ada@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", 1]);
  syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active,
    teamIds: [],
    now: 1,
  });
  const calls: Parameters<VisualReviewChanges>[0][] = [];
  let result: Awaited<ReturnType<VisualReviewChanges>> = "answered";
  const send = async (
    form: FormData,
    options: { sessionIds?: string[]; signedIn?: boolean } = {},
  ) => {
    const encoded = new Response(form);
    const type = encoded.headers.get("content-type")!;
    const body = await encoded.arrayBuffer();
    const response = await handleVisualReviewChanges(
      new Request("https://paws.example/api/visual-review-changes", {
        method: "POST",
        headers: {
          "content-type": type,
          "content-length": String(body.byteLength),
        },
        body: new Uint8Array(body),
      }),
      {
        db,
        root,
        principal: options.signedIn === false ? undefined : { workspaceId: "ws-1", userId },
        sessionIds: options.sessionIds ?? ["ses_1"],
        submit: async (input) => {
          calls.push(input);
          return result;
        },
        now: () => 1_700_000_000_000,
      },
    );
    return response!;
  };
  const form = (fields: Record<string, string | Uint8Array>) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "string") body.append(key, value);
      else body.append(key, new Blob([value]), "mark.png");
    }
    return body;
  };
  return {
    db,
    root,
    questionId: question.id,
    first,
    second,
    other,
    calls,
    send,
    form,
    answer(next: typeof result) {
      result = next;
    },
    markFiles: () =>
      readdirSync(root).filter((name) => ![first, second, other].some((row) => row.id === name)),
  };
}

describe("POST /api/visual-review-changes", () => {
  test("stores each marked screenshot apart from the original and submits it with the note", async () => {
    const h = await harness();
    const response = await h.send(
      h.form({
        questionId: h.questionId,
        note: "  Move the save button left  ",
        [`mark:${h.first.id}`]: MARKED,
      }),
    );
    expect(response.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call).toMatchObject({
      questionId: h.questionId,
      answeredBy: "delegator-1",
      note: "Move the save button left",
    });
    const [mark] = call!.marks as VisualReviewMark[];
    expect(mark).toMatchObject({
      questionId: h.questionId,
      evidenceId: h.first.id,
      sizeBytes: MARKED.byteLength,
      sha256: createHash("sha256").update(MARKED).digest("hex"),
    });
    expect(mark!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Uint8Array(readFileSync(evidencePath(h.root, mark!.id)))).toEqual(MARKED);
    expect(statSync(evidencePath(h.root, mark!.id)).mode & 0o777).toBe(0o600);
    expect(new Uint8Array(readFileSync(evidencePath(h.root, h.first.id)))).toEqual(PNG);
  });

  test("marks on several screenshots stay with their own screenshot, and no note gets a default", async () => {
    const h = await harness();
    const response = await h.send(
      h.form({
        questionId: h.questionId,
        [`mark:${h.second.id}`]: MARKED,
        [`mark:${h.first.id}`]: PNG,
      }),
    );
    expect(response.status).toBe(200);
    const marks = h.calls[0]!.marks;
    expect(marks.map((mark) => mark.evidenceId)).toEqual([h.second.id, h.first.id]);
    expect(new Uint8Array(readFileSync(evidencePath(h.root, marks[0]!.id)))).toEqual(MARKED);
    expect(new Uint8Array(readFileSync(evidencePath(h.root, marks[1]!.id)))).toEqual(PNG);
    expect(h.calls[0]!.note).toBe("See the marks on the screenshots.");
  });

  test("refuses a request without a session or with another method", async () => {
    const h = await harness();
    expect(
      (await h.send(h.form({ questionId: h.questionId, note: "x" }), { signedIn: false })).status,
    ).toBe(401);
    const get = await handleVisualReviewChanges(
      new Request("https://paws.example/api/visual-review-changes"),
      {
        db: openDatabase(":memory:"),
        root: h.root,
        principal: { workspaceId: "ws-1", userId: "user-ada" },
        sessionIds: [],
        submit: async () => "answered",
      },
    );
    expect(get!.status).toBe(405);
    expect(h.calls).toHaveLength(0);
  });

  test("a review outside the member's sessions or no longer open answers 409", async () => {
    const h = await harness();
    const hidden = await h.send(h.form({ questionId: h.questionId, note: "x" }), {
      sessionIds: ["ses_other"],
    });
    expect(hidden.status).toBe(409);
    expect((await h.send(h.form({ questionId: "missing", note: "x" }))).status).toBe(409);
    expect(h.calls).toHaveLength(0);
  });

  test("an inactive member can't request changes", async () => {
    const h = await harness(false);
    expect((await h.send(h.form({ questionId: h.questionId, note: "x" }))).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  test("a mark must be a PNG of a screenshot in this review", async () => {
    const h = await harness();
    const invalid: Record<string, string | Uint8Array>[] = [
      { [`mark:${h.other.id}`]: MARKED },
      { [`mark:${h.first.id}`]: JPEG },
      { [`mark:${h.first.id}`]: "not a file" },
      { note: "   " },
    ];
    for (const fields of invalid) {
      const response = await h.send(h.form({ questionId: h.questionId, ...fields }));
      expect(response.status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
    expect(h.markFiles()).toEqual([]);
  });

  test("when the answer is refused the marked files are removed", async () => {
    const h = await harness();
    h.answer("forbidden");
    const forbidden = await h.send(
      h.form({ questionId: h.questionId, [`mark:${h.first.id}`]: MARKED }),
    );
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: string }).error).toContain("delegated this issue");
    h.answer("rejected");
    const rejected = await h.send(
      h.form({ questionId: h.questionId, [`mark:${h.first.id}`]: MARKED }),
    );
    expect(rejected.status).toBe(409);
    expect(h.markFiles()).toEqual([]);
    expect(existsSync(evidencePath(h.root, h.first.id))).toBe(true);
  });
});

test("a stored mark is served like evidence to members who can see the task", async () => {
  const h = await harness();
  await h.send(h.form({ questionId: h.questionId, [`mark:${h.first.id}`]: MARKED }));
  const [mark] = h.calls[0]!.marks;
  saveVisualReviewMarks(h.db, [mark!]);
  const get = (sessionIds: string[]) =>
    handleEvidenceRequest(new Request(`https://paws.example/api/evidence/${mark!.id}`), {
      db: h.db,
      root: h.root,
      sessionIds,
    });
  const visible = (await get(["ses_1"]))!;
  expect(visible.status).toBe(200);
  expect(visible.headers.get("content-type")).toBe("image/png");
  expect(visible.headers.get("content-disposition")).toContain("marked-first.png");
  expect(new Uint8Array(await visible.arrayBuffer())).toEqual(MARKED);
  expect((await get(["ses_other"]))!.status).toBe(404);
});
