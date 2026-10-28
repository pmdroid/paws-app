import { journalCaught } from "../journal";
import type {
  ActionDetails,
  ActivityKind,
  AuthSignal,
  SelectOption,
  SessionPlanStep,
  SessionUpdate,
  SessionUrl,
  LinearFileTransfer,
  TrackerAdapter,
  TrackerRequestOptions,
} from "../linear";
import type { OutboxRow, OutboxDeliveryContext } from "../db";
import {
  enqueueOutboxOnce,
  getEvidence,
  getPlanProposal,
  prepareLinearActivity,
  recordPlanFiled,
  setEvidenceAssetUrl,
  listOutbox,
} from "../db";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { visualReviewBody } from "../questions";
import {
  AFTER_PULL_REQUEST_RESPONSE,
  AFTER_PULL_REQUEST_THOUGHT,
  canReportProgress,
} from "./activity-policy";
import { enqueueEvidenceAttachment, evidenceActivityBody } from "./artifacts";
import { planFiledResponse } from "./plan-proposal";

/** What `linear.evidence` rows need to upload a Closeout file: the transfer and the store root. */
export type EvidenceUploads = { files: LinearFileTransfer; root: string };

const KINDS = new Set<ActivityKind>(["thought", "action", "elicitation", "response", "error"]);

/**
 * Deliver `linear` outbox rows to the tracker.
 * `activity` posts progress. `linear.catchup` runs the poller.
 * `linear.evidence` uploads a Closeout file and posts it inline.
 */
export async function deliverLinearOutbox(
  message: OutboxRow,
  tracker: TrackerAdapter,
  catchUp: () => Promise<void>,
  context?: OutboxDeliveryContext,
  db?: Database,
  uploads?: EvidenceUploads,
): Promise<void> {
  context?.signal.throwIfAborted();
  if (context && !context.isCurrent())
    throw new Error("Linear delivery superseded by a session fence.");
  if (db && tracker.supportsActivityReconciliation) message = prepareLinearActivity(db, message);
  const payload = isRecord(message.payload) ? message.payload : {};
  const options = {
    ...(context ? { signal: context.signal, isCurrent: context.isCurrent } : {}),
    ...(message.attempts > 1 ? { reconcile: true } : {}),
  };
  if (message.op === "linear.attachment") {
    if (!tracker.createIssueAttachment) throw new Error("Linear issue attachments are unavailable");
    const id = readString(payload, "id");
    const issueId = readString(payload, "issueId");
    const title = readString(payload, "title");
    const url = readString(payload, "url");
    if (!id || !issueId || !title || !url)
      throw new Error("Issue attachment is missing required fields");
    const evidenceId = readString(payload, "evidenceId");
    if (evidenceId && !db) throw new Error("Evidence attachment needs the database");
    const evidence = evidenceId && db ? getEvidence(db, evidenceId) : null;
    await tracker.createIssueAttachment(
      {
        id,
        issueId,
        title,
        url: evidence?.assetUrl ?? url,
        ...(evidenceId ? { evidence: true } : {}),
      },
      options,
    );
    if (db && evidence) {
      for (const row of listOutbox(db, message.orderingKey ?? undefined)) {
        const old = row.payload as Record<string, unknown>;
        if (
          row.op === "linear.attachment" &&
          old.itemId === payload.itemId &&
          old.evidenceId &&
          old.headCommit !== evidence.headCommit &&
          row.id < message.id &&
          row.status === "sent"
        ) {
          if (!tracker.deleteIssueAttachment)
            throw new Error("Evidence attachment replacement is unavailable");
          await tracker.deleteIssueAttachment(String(old.id), options);
        }
      }
    }
    return;
  }
  if (message.op === "linear.repository_label") {
    if (!tracker.addRepositoryLabel) throw new Error("Linear repository labels are unavailable");
    const issueId = readString(payload, "issueId");
    const repository = readString(payload, "repository");
    if (!issueId || !repository) throw new Error("Repository label is missing required fields");
    return tracker.addRepositoryLabel({ issueId, repository }, options);
  }
  if (message.op === "linear.sub_issues") {
    if (!db) throw new Error("Sub-issue filing needs the database");
    return fileSubIssues(message, payload, tracker, db, options);
  }
  if (message.op === "activity") {
    const terminal =
      (payload.kind === "response" && AFTER_PULL_REQUEST_RESPONSE.test(message.idempotencyKey)) ||
      (payload.kind === "thought" && AFTER_PULL_REQUEST_THOUGHT.test(message.idempotencyKey));
    if (
      db &&
      !terminal &&
      !canReportProgress(db, message.orderingKey ?? "", message.generation ?? 0, message.id)
    )
      return;
    return postActivity(message, payload, tracker, options);
  }
  if (message.op === "linear.evidence") {
    if (!db) throw new Error("Evidence delivery needs the database");
    return postEvidence(message, payload, tracker, db, uploads, options);
  }
  if (message.op.startsWith("linear.session.")) {
    return postSession(payload, tracker, options);
  }
  if (message.op === "elicitation") {
    if (
      db &&
      !canReportProgress(db, message.orderingKey ?? "", message.generation ?? 0, message.id) &&
      !db
        .query(
          "SELECT 1 FROM work_item_event e JOIN question q ON q.id=e.payload_digest WHERE e.kind='ask' AND q.session_id=? AND q.id=? AND q.cancelled_at IS NULL AND q.status='open' LIMIT 1",
        )
        .get(message.orderingKey, readString(payload, "questionId"))
    )
      return;
    return postElicitation(payload, tracker, options, db);
  }
  if (message.op === "status") {
    return postStatus(payload, tracker, options);
  }
  if (message.op === "catchup" || message.op === "linear.catchup") {
    return catchUp();
  }
  throw new Error(`unknown linear outbox op ${message.op}`);
}

/**
 * File an approved plan, then queue the one response that lists what was filed.
 * The tracker call is idempotent per approval question, and the recorded result
 * stops a retried row from calling it again.
 */
async function fileSubIssues(
  message: OutboxRow,
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  db: Database,
  options?: TrackerRequestOptions,
): Promise<void> {
  if (!tracker.createSubIssues) throw new Error("Linear sub-issue creation is unavailable");
  const questionId = readString(payload, "questionId");
  const sessionId = readString(payload, "sessionId") ?? message.orderingKey;
  const proposal = questionId ? getPlanProposal(db, questionId) : null;
  if (!questionId || !sessionId || !proposal)
    throw new Error("Sub-issue filing is missing its approved proposal");
  const filed =
    proposal.filed ??
    (await tracker.createSubIssues(
      {
        key: questionId,
        parentIssueId: proposal.parentIssueId,
        drafts: proposal.drafts,
        repository: proposal.repository,
      },
      options,
    ));
  const recorded = recordPlanFiled(db, questionId, filed, Date.now());
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    idempotencyKey: `plan-filed:${questionId}`,
    payload: {
      sessionId,
      kind: "response",
      body: planFiledResponse(
        readString(payload, "identifier") ?? "the issue",
        recorded.filed ?? filed,
      ),
    },
  });
}

async function postActivity(
  message: OutboxRow,
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  options?: TrackerRequestOptions,
): Promise<void> {
  const sessionId = readString(payload, "sessionId") ?? message.orderingKey;
  const body = readString(payload, "body") ?? readString(payload, "text");
  if (sessionId === null || sessionId.length === 0) throw new Error("activity has no session");
  if (body === null) throw new Error("activity has no body");
  const kind = readKind(payload["kind"]);
  if (kind === null) throw new Error("activity has no valid kind");
  const id = optionalString(payload, "id");
  const action = readAction(payload["action"]);
  const ephemeral = payload["ephemeral"];
  if (ephemeral !== undefined && typeof ephemeral !== "boolean") {
    throw new Error("activity ephemeral must be a boolean");
  }
  if (ephemeral && kind !== "thought" && kind !== "action")
    throw new Error("Only thought and action activities can be ephemeral");
  if (action && kind !== "action") throw new Error("Structured details require an action");
  const update = {
    sessionId,
    kind,
    body,
    ...(id === undefined ? {} : { id }),
    ...(action === undefined ? {} : { action }),
    ...(ephemeral === undefined ? {} : { ephemeral }),
  };
  const session = isRecord(payload["session"]) ? readSessionUpdate(payload["session"]) : null;
  if (session && tracker.postProgressWithSession)
    return tracker.postProgressWithSession(update, session, options);
  await tracker.postProgress(update, options);
  if (session) await sendSessionUpdate(session, tracker, options);
}

/**
 * Uploads the evidence file once and keeps its asset URL on the evidence row, so a retry
 * after a failed post does not upload again. A failed upload throws for the outbox to retry;
 * the last attempt posts the Paws link with a note instead.
 */
async function postEvidence(
  message: OutboxRow,
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  db: Database,
  uploads: EvidenceUploads | undefined,
  options: TrackerRequestOptions,
): Promise<void> {
  const id = readString(payload, "id");
  const sessionId = readString(payload, "sessionId");
  const evidenceId = readString(payload, "evidenceId");
  const checkId = readString(payload, "checkId");
  const link = readString(payload, "link");
  if (!id || !sessionId || !evidenceId || !checkId || !link)
    throw new Error("Evidence activity is missing required fields");
  const evidence = getEvidence(db, evidenceId);
  if (evidence === null) throw new Error("Evidence activity has no evidence row");
  let assetUrl = evidence.assetUrl ?? undefined;
  let note: string | undefined;
  if (assetUrl === undefined) {
    try {
      if (!uploads) throw new Error("Linear file uploads are unavailable");
      const bytes = new Uint8Array(await readFile(join(uploads.root, evidence.id)));
      if (
        bytes.byteLength !== evidence.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== evidence.sha256
      )
        throw new Error("Evidence file integrity check failed");
      const uploaded = await uploads.files.upload({
        filename: evidence.displayName,
        contentType: evidence.mediaType,
        bytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      assetUrl = uploaded.assetUrl;
      setEvidenceAssetUrl(db, evidence.id, assetUrl);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (message.attempts < message.maxAttempts) throw error;
      journalCaught(error, "dispatch.postEvidence.readFile", null, "optional file may be absent");
      note = "Paws could not upload this file to Linear.";
    }
  }
  const quiet = !canReportProgress(db, sessionId, message.generation ?? 0, message.id);
  if (quiet)
    enqueueEvidenceAttachment(db, {
      sessionId,
      generation: message.generation ?? 0,
      itemId: evidence.itemId,
      evidenceId,
      title: evidence.displayName,
      url: link,
      headCommit: evidence.headCommit,
      now: Date.now(),
    });
  if (payload["uploadOnly"] === true || quiet) return;
  await tracker.postProgress(
    {
      sessionId,
      kind: "thought",
      id,
      body: evidenceActivityBody({
        checkId,
        displayName: evidence.displayName,
        link,
        ...(assetUrl === undefined ? {} : { assetUrl }),
        ...(note === undefined ? {} : { note }),
      }),
    },
    options,
  );
}

async function postElicitation(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  requestOptions?: TrackerRequestOptions,
  db?: Database,
): Promise<void> {
  const sessionId = readString(payload, "sessionId");
  const body =
    payload["evidence"] !== undefined && db
      ? reviewBody(payload["evidence"], payload["carried"], db)
      : readString(payload, "body");
  if (sessionId === null || body === null)
    throw new Error("elicitation is missing session or body");
  const options = readOptions(payload["options"]);
  const questionId = readString(payload, "questionId");
  const id = optionalString(payload, "id");
  const auth = readAuth(payload["auth"]);
  await tracker.askQuestion(
    {
      sessionId,
      body,
      ...(questionId === null ? {} : { questionId }),
      ...(id === undefined ? {} : { id }),
      ...(auth === undefined ? {} : { auth }),
      ...(options.length > 0 ? { options } : {}),
    },
    requestOptions,
  );
}

/**
 * A visual review runs after the session's `linear.evidence` rows, so the files it shows have
 * their Linear uploads by now. A file without one is shown as its Paws link.
 */
function reviewBody(value: unknown, carried: unknown, db: Database): string {
  if (!Array.isArray(value)) throw new Error("visual review evidence must be an array");
  const file = (entry: unknown) => {
    const id = isRecord(entry) ? readString(entry, "id") : null;
    const link = isRecord(entry) ? readString(entry, "link") : null;
    if (id === null || link === null) throw new Error("visual review evidence needs id and link");
    const row = getEvidence(db, id);
    if (row === null) throw new Error("Visual review has no evidence row");
    return {
      displayName: row.displayName,
      link,
      ...(row.assetUrl ? { assetUrl: row.assetUrl } : {}),
    };
  };
  return visualReviewBody(
    value.map((entry) => {
      const approved = isRecord(entry) ? entry["approved"] : undefined;
      return { ...file(entry), ...(approved === undefined ? {} : { approved: file(approved) }) };
    }),
    (Array.isArray(carried) ? carried : []).flatMap((id) => {
      const row = typeof id === "string" ? getEvidence(db, id) : null;
      return row ? [row.displayName] : [];
    }),
  );
}

async function postSession(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  options?: TrackerRequestOptions,
): Promise<void> {
  await sendSessionUpdate(readSessionUpdate(payload), tracker, options);
}

async function sendSessionUpdate(
  update: SessionUpdate,
  tracker: TrackerAdapter,
  options?: TrackerRequestOptions,
): Promise<void> {
  if (!tracker.updateSession) throw new Error("Tracker does not support session updates");
  const signal = AbortSignal.any([
    ...(options?.signal ? [options.signal] : []),
    AbortSignal.timeout(5000),
  ]);
  await tracker.updateSession(update, { ...options, signal });
}

function readSessionUpdate(payload: Record<string, unknown>): SessionUpdate {
  const sessionId = readString(payload, "sessionId");
  if (sessionId === null) throw new Error("session update requires a session");
  const update: SessionUpdate = { sessionId };
  if (payload.plan !== undefined) {
    if (!Array.isArray(payload.plan)) throw new Error("session plan must be an array");
    update.plan = payload.plan.map((step): SessionPlanStep => {
      if (
        !isRecord(step) ||
        typeof step.content !== "string" ||
        !["pending", "inProgress", "completed", "canceled"].includes(String(step.status))
      ) {
        throw new Error("session plan requires content and status");
      }
      return { content: step.content, status: step.status as SessionPlanStep["status"] };
    });
  }
  if (payload.summary !== undefined) {
    if (payload.summary !== null && typeof payload.summary !== "string")
      throw new Error("session summary must be text or null");
    update.summary = payload.summary;
  }
  for (const field of ["externalUrls", "addedExternalUrls"] as const) {
    if (payload[field] === undefined) continue;
    if (!Array.isArray(payload[field])) throw new Error("session links must be an array");
    update[field] = payload[field].map((entry): SessionUrl => {
      if (!isRecord(entry) || typeof entry.label !== "string" || typeof entry.url !== "string")
        throw new Error("session links require label and URL");
      return { label: entry.label, url: entry.url };
    });
  }
  if (payload.removedExternalUrls !== undefined) {
    if (
      !Array.isArray(payload.removedExternalUrls) ||
      payload.removedExternalUrls.some((url) => typeof url !== "string")
    )
      throw new Error("removed session links must be an array of URLs");
    update.removedExternalUrls = [...payload.removedExternalUrls];
  }
  return update;
}

async function postStatus(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  options?: TrackerRequestOptions,
): Promise<void> {
  const linearIssueId = readString(payload, "linearIssueId");
  const stateType = readString(payload, "stateType");
  if (linearIssueId === null || !isStateType(stateType)) {
    throw new Error("status update is missing an issue or state");
  }
  await tracker.setStatus({ linearIssueId, stateType }, options);
}

function readKind(value: unknown): ActivityKind | null {
  return typeof value === "string" && KINDS.has(value as ActivityKind)
    ? (value as ActivityKind)
    : null;
}

function readOptions(value: unknown): (string | SelectOption)[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("elicitation options must be an array");
  return value.map((option) => {
    if (typeof option === "string" && option.trim().length > 0) return option;
    if (isRecord(option)) {
      const label = optionalString(option, "label");
      const optionValue = readString(option, "value");
      if (optionValue !== null)
        return { value: optionValue, ...(label === undefined ? {} : { label }) };
    }
    throw new Error("elicitation options must be strings or label/value choices");
  });
}

function readAction(value: unknown): ActionDetails | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("activity action must be structured");
  const action = readString(value, "action");
  const parameter = value["parameter"];
  const result = value["result"];
  if (
    action === null ||
    typeof parameter !== "string" ||
    (result !== undefined && typeof result !== "string")
  ) {
    throw new Error("activity action requires action and parameter strings");
  }
  return { action, parameter, ...(result === undefined ? {} : { result }) };
}

function readAuth(value: unknown): AuthSignal | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("elicitation auth must be structured");
  const url = readString(value, "url");
  if (url === null) throw new Error("elicitation auth requires a URL");
  const userId = optionalString(value, "userId");
  const providerName = optionalString(value, "providerName");
  return {
    url,
    ...(userId === undefined ? {} : { userId }),
    ...(providerName === undefined ? {} : { providerName }),
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (record[key] === undefined) return undefined;
  const value = readString(record, key);
  if (value === null) throw new Error(`${key} must be a nonempty string`);
  return value;
}

function isStateType(value: string | null): value is "started" | "completed" | "canceled" {
  return value === "started" || value === "completed" || value === "canceled";
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
