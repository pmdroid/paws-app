import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  endLivePreview,
  getLinkAsk,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  livePreviewApprovals,
  migrate,
  openDatabase,
  saveCheckpoint,
  saveLivePreview,
  unacceptedLivePreview,
} from "../db";
import { PreviewReadySchema } from "../live-preview";
import { saveSchedulingContext } from "../scheduler";
import { askWithLink, decideLinkAsk, guideLinkAsk } from "./link-ask";

const HEAD = "a".repeat(40);
const NOW = Date.now();
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function waiting() {
  const db = openDatabase(":memory:");
  databases.push(db);
  migrate(db);
  const item = insertQueuedItem(db, { id: "preview-item", sessionKey: "session", now: NOW });
  const { run } = beginImplementRun(db, item.id, NOW);
  db.run("UPDATE work_item SET delegated_by='delegator' WHERE id=?", [item.id]);
  saveSchedulingContext(db, { itemId: item.id, projectId: "project", projectLeadId: "lead" });
  db.run("INSERT INTO workspace VALUES('ws','org','Test',?)", [NOW]);
  db.run(
    "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('user','lead','Lead','lead@example.invalid')",
  );
  saveCheckpoint(db, item.id, { phase: "running", wipCommit: HEAD });
  const { question } = askWithLink(db, {
    item: getWorkItem(db, item.id)!,
    runId: run.id,
    kind: "preview",
    head: HEAD,
    publicUrl: "https://paws.example",
    detail: "Try the app",
    now: NOW,
  });
  const preview = PreviewReadySchema.parse({
    id: randomUUID(),
    command: ["bun", "run", "fixture"],
    port: 3123,
    checklist: ["Sign in"],
    head: HEAD,
    url: "https://paws-preview-1.tail.ts.net/",
    expiresAt: NOW + 3600000,
    frameable: true,
  });
  saveLivePreview(db, item.id, question.id, preview);
  return { db, itemId: item.id, questionId: question.id, preview };
}
function accept(f: ReturnType<typeof waiting>, answeredBy = "lead", now = NOW + 10) {
  return decideLinkAsk(f.db, {
    questionId: f.questionId,
    decision: "approve",
    note: null,
    answeredBy,
    actor: { workspaceId: "ws", userId: "user", name: "Lead" },
    now,
  });
}

test("only the delegator or project lead can accept; acceptance stays on the exact commit", () => {
  const f = waiting();
  expect(accept(f, "outsider")).toBe("forbidden");
  expect(livePreviewApprovals(f.db, f.itemId, "task")).toEqual([]);
  expect(accept(f)).toBe("answered");
  expect(getWorkItem(f.db, f.itemId)?.state).toBe("running");
  expect(livePreviewApprovals(f.db, f.itemId, "task")).toMatchObject([
    { checkId: "live-preview", commit: HEAD, evidenceIds: [`preview:${HEAD}`], approvedBy: "lead" },
  ]);
  expect(unacceptedLivePreview(f.db, f.itemId, HEAD)).toBe(false);
  expect(unacceptedLivePreview(f.db, f.itemId, "b".repeat(40))).toBe(true);
});

test("expired, stopped, and moved previews cannot be accepted", () => {
  const expired = waiting();
  expect(accept(expired, "lead", NOW + 3600001)).toBe("rejected");
  const stopped = waiting();
  endLivePreview(stopped.db, stopped.preview.id, NOW + 1);
  expect(accept(stopped)).toBe("rejected");
  const moved = waiting();
  saveCheckpoint(moved.db, moved.itemId, { phase: "awaiting_input", wipCommit: "b".repeat(40) });
  expect(accept(moved)).toBe("rejected");
});

test("Request changes goes through restart with feedback", () => {
  const f = waiting();
  expect(
    decideLinkAsk(f.db, {
      questionId: f.questionId,
      decision: "changes",
      note: "The save button does nothing",
      answeredBy: "lead",
      actor: { workspaceId: "ws", userId: "user", name: "Lead" },
      now: NOW + 10,
    }),
  ).toBe("answered");
  expect(getWorkItem(f.db, f.itemId)?.state).toBe("queued");
  const resume = listJobs(f.db).find((job) => job.queue === JOB_KIND.resume);
  expect((resume!.payload as { handoff: string }).handoff).toContain(
    "The save button does nothing",
  );
  expect(unacceptedLivePreview(f.db, f.itemId, HEAD)).toBe(true);
});

test("a Linear reply saying Accept restarts with feedback and cannot approve", () => {
  const f = waiting();
  expect(
    guideLinkAsk(f.db, {
      questionId: f.questionId,
      eventKey: "reply",
      body: "Accept",
      answeredBy: "lead",
      now: NOW + 10,
    }),
  ).toBe(true);
  expect(getLinkAsk(f.db, f.questionId)?.decision).toBeNull();
  expect(getWorkItem(f.db, f.itemId)?.state).toBe("queued");
  expect(livePreviewApprovals(f.db, f.itemId, "task")).toEqual([]);
  expect(
    (listJobs(f.db).find((job) => job.queue === JOB_KIND.resume)!.payload as { handoff: string })
      .handoff,
  ).toContain("Accept");
});

test("an unauthorized Linear reply cannot close or restart a preview", () => {
  const f = waiting();
  expect(
    guideLinkAsk(f.db, {
      questionId: f.questionId,
      eventKey: "outsider-reply",
      body: "change it",
      answeredBy: "outsider",
      now: NOW + 10,
    }),
  ).toBe(false);
  expect(getLinkAsk(f.db, f.questionId)?.closedAt).toBeNull();
  expect(getWorkItem(f.db, f.itemId)?.state).toBe("awaiting_input");
  expect(listJobs(f.db).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
});

test("a later accepted preview supersedes an abandoned optional check id", () => {
  const f = waiting();
  const abandoned = { ...f.preview, checkId: "old-optional-name" };
  // Keep an earlier declined preview for a different id in the item's history.
  f.db.run("UPDATE live_preview SET ready=? WHERE id=?", [JSON.stringify(abandoned), f.preview.id]);
  expect(unacceptedLivePreview(f.db, f.itemId, HEAD)).toBe(true);
  expect(
    decideLinkAsk(f.db, {
      questionId: f.questionId,
      decision: "changes",
      note: "Try the corrected preview",
      answeredBy: "lead",
      actor: { workspaceId: "ws", userId: "user", name: "Lead" },
      now: NOW + 1,
    }),
  ).toBe("answered");
  beginImplementRun(f.db, f.itemId, NOW + 2);
  const { question } = askWithLink(f.db, {
    item: getWorkItem(f.db, f.itemId)!,
    runId: getWorkItem(f.db, f.itemId)!.currentRunId!,
    kind: "preview",
    head: HEAD,
    publicUrl: "https://paws.example",
    detail: "Try the new preview",
    now: NOW + 1,
  });
  saveLivePreview(f.db, f.itemId, question.id, { ...f.preview, id: randomUUID() });
  expect(accept({ ...f, questionId: question.id })).toBe("answered");
  expect(unacceptedLivePreview(f.db, f.itemId, HEAD)).toBe(false);
  expect(unacceptedLivePreview(f.db, f.itemId, "b".repeat(40))).toBe(true);
});
