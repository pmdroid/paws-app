import type { Database } from "bun:sqlite";
import { isTerminalWorkItemState } from "../core";
import {
  commentOpenedAgentSessionSteps,
  itemsForLinearIssueSteps,
  linearStoppedAfterSteps,
  parentIssueSessionSteps,
  applyLinearTurnsSteps,
  DEFAULT_PULL_FEEDBACK_WAIT,
  emitJobReady,
  enqueueOutboxOnceSteps,
  gatherLinearCommentsSteps,
  getLinearCommentSteps,
  getLinearSessionSteps,
  getLinearSessionAccessSteps,
  getLinearSessionInstallationSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  linearCommentAuthorSteps,
  listPendingLinearTurnsSteps,
  markLinearCommentsDeliveredSteps,
  pendingChangeRequestsSteps,
  pendingLinearCommentsSteps,
  pendingPullCiFailuresSteps,
  pendingPullCommentsSteps,
  queueLinearCommentSteps,
  restartSteps,
  settled,
  settleLinearCommentsSteps,
  sqliteDb,
  type Db,
  type LinearCommentAuthority,
  type LinearCommentRecord,
  type PullFeedbackWait,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import type { LeaveMergeQueueResult } from "../github";
import { isPawsStop } from "../linear";
import { findOpenQuestion } from "../questions";
import { publicToolText } from "./activity";

export type LinearCommentActor = { id: string; teamId: string | null };

export type LinearCommentPolicy = {
  appUserId: string | null;
  agents: readonly string[];
  authorize?(actor: LinearCommentActor): Promise<boolean>;
  recheck?(actor: LinearCommentActor): boolean | null;
  wait?(): PullFeedbackWait;
};

export type LinearCommentRoute =
  | {
      kind: "settle";
      state: "ignored" | "rejected";
      reason: string;
      notify?: { sessionId: string; body: string };
    }
  | {
      kind: "queue";
      item: WorkItemRecord;
      sessionId: string;
      generation: number;
      teamId: string | null;
      authority: LinearCommentAuthority;
      actors: string[];
    };

export type LinearCommentStep = "done" | "wait" | "restarted";

export type LinearConversationTurn = {
  commandId: string;
  sessionId: string;
  result: { text: string; replies?: string[]; startWork?: string; timedOut: boolean } | null;
  expired: boolean;
};

export type LinearConversations = {
  lane(itemId: string): Promise<"closed" | "full" | "free">;
  start(itemId: string, sessionId: string, prompt: string): boolean;
  open(itemId: string): Promise<LinearConversationTurn[]>;
  finish(commandId: string): void;
};

export type LinearCommentCapabilities = {
  now(): number;
  policy: LinearCommentPolicy;
  busy(item: WorkItemRecord): Promise<boolean>;
  leaveMergeQueue(item: WorkItemRecord, pullNumber: number): Promise<LeaveMergeQueueResult>;
  flush(): Promise<void>;
  conversations?(): Promise<LinearConversations | null>;
  resumeSession?(sessionId: string): Promise<void>;
};

const HELD_STATES = new Set(["paused", "manual", "failed"]);
const CONVERSATION_STATES = new Set(["queued", "merge_queue"]);
const CONVERSATION_PROMPT_CHARS = 60_000;

export const START_WORK_RESPONSE = "Starting work: ";
const START_WORK_REFUSED =
  "I could not start the work: the item moved on while we talked. Reply to try again.";
const START_WORK_HANDOFF =
  "In the conversation you called start_work with this plan. This is the work turn: edits, commits and Closeout are allowed. Carry out the plan.";

export const CONVERSATION_TIMEOUT_REPLY = "I stopped checking after 15 minutes. Reply to continue.";
const CONVERSATION_EMPTY_REPLY = "I could not answer this time. Reply to try again.";
const ACTIVE_STATES = new Set(["running", "verifying", "recovering"]);
const COMMENT_CHARS = 4_000;
const SECTION_CHARS = 12_000;

export const LINEAR_COMMENT_RESTART =
  "Comments on the Linear issue came in after this work was accepted. They follow in this turn's instructions. Address them, then finish the work as before.";

export const LINEAR_COMMENT_INSTRUCTION =
  "These comments were posted on the Linear issue while you worked on it. Treat them as direction from the team. A comment can be a question, a note or a status line rather than a request; change nothing for those.";

export async function routeLinearComment(
  db: Database,
  comment: LinearCommentRecord,
  policy: LinearCommentPolicy,
): Promise<LinearCommentRoute> {
  return await sqliteDb(db).run((q) => routeLinearCommentSteps(q, comment, policy));
}

function* routeLinearCommentSteps(
  q: Q,
  comment: LinearCommentRecord,
  policy: LinearCommentPolicy,
): Steps<LinearCommentRoute> {
  const settle = (state: "ignored" | "rejected", reason: string): LinearCommentRoute => ({
    kind: "settle",
    state,
    reason,
  });
  if (comment.body.trim() === "") return settle("ignored", "empty");
  if (isPawsStop(comment.body)) return settle("ignored", "control");
  if (comment.authorId === null) return settle("rejected", "unknown_author");
  if (policy.appUserId !== null && comment.authorId === policy.appUserId)
    return settle("ignored", "own");
  const agent = policy.agents.includes(comment.authorId);
  if (!agent && (comment.botActor !== null || (comment.actorType ?? "user") !== "user"))
    return settle("ignored", "bot");
  if (yield* inAgentSessionSteps(q, comment, policy.appUserId))
    return settle("ignored", "agent_session");
  const items = yield* itemsForLinearIssueSteps(q, comment.issueId);
  const open = items.filter(
    (row) => !isTerminalWorkItemState(row.state as WorkItemRecord["state"]),
  );
  if (open.length === 0) {
    if (items.length > 0) return settle("ignored", "ended");
    const parent = yield* parentIssueSessionSteps(q, comment.issueId);
    if (parent !== null)
      return {
        kind: "settle",
        state: "rejected",
        reason: "parent_issue",
        notify: {
          sessionId: parent,
          body: "A comment on this parent issue was not passed on: each sub-issue runs in its own session. Comment on the sub-issue whose work it is about.",
        },
      };
    return settle("ignored", "not_delegated");
  }
  const item = (yield* getWorkItemSteps(q, open[0]!.id))!;
  if (comment.createdAtMs < open[0]!.createdAt) return settle("ignored", "before_delegation");
  if (item.cancelRequested) return settle("ignored", "ended");
  if (item.sessionKey === null) return settle("rejected", "no_session");
  const session = yield* getLinearSessionSteps(q, item.sessionKey);
  if (session === null || session.stoppedAt !== null) return settle("ignored", "session_stopped");
  const installation = yield* getLinearSessionInstallationSteps(q, item.sessionKey);
  if (
    (yield* getLinearSessionAccessSteps(q, item.sessionKey)) !== "allowed" ||
    installation === null
  )
    return settle("rejected", "access");
  if (comment.organizationId !== null && comment.organizationId !== installation.organizationId)
    return settle("rejected", "workspace");
  if (
    comment.teamId !== null &&
    installation.teamId !== null &&
    comment.teamId !== installation.teamId
  )
    return settle("rejected", "team");
  const actors = agent
    ? comment.onBehalfOf === null
      ? []
      : [comment.onBehalfOf]
    : [comment.authorId];
  return {
    kind: "queue",
    item,
    sessionId: item.sessionKey,
    generation: session.generation,
    teamId: installation.teamId,
    authority: agent ? "agent" : "person",
    actors,
  };
}

export async function authorizeLinearComment(
  route: Extract<LinearCommentRoute, { kind: "queue" }>,
  policy: LinearCommentPolicy,
): Promise<boolean> {
  if (policy.authorize === undefined) return true;
  for (const id of route.actors)
    if (!(await policy.authorize({ id, teamId: route.teamId }))) return false;
  return true;
}

export async function commitLinearCommentRoute(
  db: Database,
  commentId: string,
  route: LinearCommentRoute,
  options: { now: number; wait?: PullFeedbackWait; authorized: boolean },
): Promise<LinearCommentRecord | null> {
  const store = sqliteDb(db);
  const job = { ready: false };
  const comment = await store.transaction((q) =>
    commitLinearCommentRouteSteps(q, commentId, route, options, job),
  );
  if (job.ready) emitJobReady(store);
  return comment;
}

function* commitLinearCommentRouteSteps(
  q: Q,
  commentId: string,
  route: LinearCommentRoute,
  options: { now: number; wait?: PullFeedbackWait; authorized: boolean },
  job: { ready: boolean },
): Steps<LinearCommentRecord | null> {
  const comment = yield* getLinearCommentSteps(q, commentId);
  if (comment === null || comment.state !== "received") return comment;
  if (route.kind === "settle") {
    yield* settleLinearCommentsSteps(q, [commentId], {
      state: route.state,
      reason: route.reason,
      now: options.now,
    });
    if (route.notify)
      yield* enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: route.notify.sessionId,
        idempotencyKey: `linear-comment:${route.reason}:${commentId}`,
        payload: {
          sessionId: route.notify.sessionId,
          kind: "thought",
          body: route.notify.body,
          id: crypto.randomUUID(),
        },
        now: options.now,
      });
    return yield* getLinearCommentSteps(q, commentId);
  }
  if (!options.authorized) {
    yield* settleLinearCommentsSteps(q, [commentId], {
      state: "rejected",
      reason: route.authority === "agent" ? "on_behalf_of" : "not_member",
      now: options.now,
    });
    return yield* getLinearCommentSteps(q, commentId);
  }
  const item = yield* getWorkItemSteps(q, route.item.id);
  if (
    item === null ||
    isTerminalWorkItemState(item.state) ||
    item.cancelRequested ||
    item.sessionKey !== route.sessionId
  ) {
    yield* settleLinearCommentsSteps(q, [commentId], {
      state: "ignored",
      reason: "ended",
      now: options.now,
    });
    return yield* getLinearCommentSteps(q, commentId);
  }
  yield* queueLinearCommentSteps(q, commentId, {
    itemId: item.id,
    sessionId: route.sessionId,
    generation: route.generation,
    authority: route.authority,
  });
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: route.sessionId,
    idempotencyKey: `linear-comment:received:${commentId}`,
    payload: {
      sessionId: route.sessionId,
      kind: "thought",
      body: receivedNote(item),
      id: crypto.randomUUID(),
    },
    now: options.now,
  });
  job.ready = yield* gatherLinearCommentsSteps(
    q,
    item.id,
    options.now,
    options.wait ?? DEFAULT_PULL_FEEDBACK_WAIT,
    `linear-comments:${item.id}:${commentId}`,
  );
  return yield* getLinearCommentSteps(q, commentId);
}

export function receivedNote(item: WorkItemRecord): string {
  const issue = item.linearIdentifier;
  if (item.state === "paused")
    return `Received a comment on ${issue}. The task is paused, so the comment waits with it and reaches the agent when the task resumes.`;
  if (item.state === "manual")
    return `Received a comment on ${issue}. The task is held for a person, so the comment waits with it and reaches the agent when the task runs again.`;
  if (item.state === "failed")
    return `Received a comment on ${issue}. The task has stopped, so the comment waits with it. Reply in this session to run the task again.`;
  if (item.state === "awaiting_input")
    return `Received a comment on ${issue}. It is not taken as the answer to the question here; it reaches the agent when the task runs again.`;
  if (item.state === "running")
    return `Received a comment on ${issue}. Paws hands it to the agent once its current turn ends.`;
  return `Received a comment on ${issue}. Paws hands it to the agent at its next turn.`;
}

export async function deliverLinearComments(
  db: Database,
  itemId: string,
  caps: LinearCommentCapabilities,
): Promise<LinearCommentStep> {
  const store = sqliteDb(db);
  const item = await store.run((q) => getWorkItemSteps(q, itemId));
  const talk = (await caps.conversations?.()) ?? null;
  if (talk !== null) {
    if (await postConversationReplies(store, itemId, talk, caps)) await caps.flush();
    if ((await talk.open(itemId)).length > 0) return "wait";
  }
  const all = await store.run((q) => pendingLinearCommentsSteps(q, itemId));
  const idle = talk !== null && item !== null && canConverse(item) && !(await caps.busy(item));
  const turns = idle
    ? await store.run((q) => listPendingLinearTurnsSteps(q, item.sessionKey!))
    : [];
  if (all.length === 0 && turns.length === 0) return "done";
  if (item === null || isTerminalWorkItemState(item.state) || item.cancelRequested) {
    await store.transaction((q) =>
      settleLinearCommentsSteps(
        q,
        all.map((comment) => comment.commentId),
        { state: "ignored", reason: "ended", now: caps.now() },
      ),
    );
    return "done";
  }
  const { kept, unknown } = await store.run((q) => currentSteps(q, item, all, caps));
  if (idle) {
    const lane = await talk!.lane(item.id);
    if (lane === "full") return "wait";
    if (lane === "free" && (kept.length > 0 || turns.length > 0)) {
      await startConversation(store, item, kept, turns, talk!, caps.now());
      return "wait";
    }
  }
  if (turns.length > 0) await caps.resumeSession?.(item.sessionKey!);
  if (kept.length === 0) return unknown ? "wait" : "done";
  if (item.state === "awaiting_input") {
    const question = findOpenQuestion(db, item.sessionKey!);
    if (question !== null) {
      await store.transaction((q) =>
        enqueueOutboxOnceSteps(q, {
          target: "linear",
          op: "activity",
          orderingKey: item.sessionKey!,
          idempotencyKey: `linear-comment:question:${question.id}:${kept.at(-1)!.commentId}`,
          payload: {
            sessionId: item.sessionKey!,
            kind: "thought",
            body: "Paws keeps the comment on the issue as context for the agent. The open question here still needs an answer in this session.",
            id: crypto.randomUUID(),
          },
          now: caps.now(),
        }),
      );
      await caps.flush();
    }
    return "done";
  }
  if (HELD_STATES.has(item.state) || item.state === "queued") return "done";
  if (ACTIVE_STATES.has(item.state)) return "wait";
  if (item.state !== "merge_queue" || (await caps.busy(item))) return "wait";
  const pull = await store.run((q) => getItemPullRequestSteps(q, item.id));
  if (pull !== null) {
    const queue = await caps.leaveMergeQueue(item, pull.pullNumber);
    if (queue === "merged") return "wait";
    if (queue === "closed") {
      await store.transaction(function* (q) {
        yield* settleLinearCommentsSteps(
          q,
          (yield* pendingLinearCommentsSteps(q, item.id)).map((comment) => comment.commentId),
          { state: "ignored", reason: "pull_closed", now: caps.now() },
        );
        yield* enqueueOutboxOnceSteps(q, {
          target: "linear",
          op: "activity",
          orderingKey: item.sessionKey!,
          idempotencyKey: `linear-comment:pull-closed:${item.id}:${pull.pullNumber}`,
          payload: {
            sessionId: item.sessionKey!,
            kind: "thought",
            body: `Pull request #${pull.pullNumber} was closed without merging, so Paws did not pass the comment on ${item.linearIdentifier} to the agent.`,
            id: crypto.randomUUID(),
          },
          now: caps.now(),
        });
      });
      await caps.flush();
      return "done";
    }
  }
  if (
    (await store.run((q) => pendingPullCommentsSteps(q, item.id))).length > 0 ||
    (await store.run((q) => pendingPullCiFailuresSteps(q, item.id))).length > 0 ||
    (await store.run((q) => pendingChangeRequestsSteps(q, item.id))).length > 0
  )
    return "wait";
  const job = { ready: false };
  const step = await store.transaction(function* (q): Steps<LinearCommentStep> {
    const latest = yield* getWorkItemSteps(q, item.id);
    if (latest === null || latest.version !== item.version || latest.state !== "merge_queue")
      return "wait";
    const ready = yield* currentSteps(
      q,
      latest,
      yield* pendingLinearCommentsSteps(q, item.id),
      caps,
    );
    const batch = ready.kept;
    if (linearCommentSection(batch, latest.linearIdentifier) === null)
      return ready.unknown ? "wait" : "done";
    const jobKey = `linear-comment:${latest.id}:${batch[0]!.commentId}`;
    const restarted = yield* restartSteps(q, latest, {
      reason: "follow_up",
      body: LINEAR_COMMENT_RESTART,
      jobKey,
      now: caps.now(),
    });
    if (restarted === null) return "wait";
    job.ready = restarted.armed;
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: latest.sessionKey!,
      idempotencyKey: `linear-comment:restarted:${batch[0]!.commentId}`,
      payload: {
        sessionId: latest.sessionKey!,
        kind: "thought",
        body: `Sent ${latest.linearIdentifier} back to the agent for ${count(batch)}. The agent reads ${batch.length === 1 ? "it" : "them"} when its next turn starts.`,
        id: crypto.randomUUID(),
      },
      now: caps.now(),
    });
    return "restarted";
  });
  if (job.ready) emitJobReady(store);
  if (step === "restarted") await caps.flush();
  return step;
}

export function canConverse(item: WorkItemRecord): boolean {
  return item.sessionKey !== null && !item.cancelRequested && CONVERSATION_STATES.has(item.state);
}

async function startConversation(
  store: Db,
  item: WorkItemRecord,
  comments: readonly LinearCommentRecord[],
  turns: readonly { eventKey: string; body: string }[],
  talk: LinearConversations,
  now: number,
): Promise<void> {
  const batch = fitLinearComments(comments);
  const section = linearCommentSection(batch, item.linearIdentifier);
  const parts = section === null ? [] : [section];
  const sent: string[] = [];
  for (const turn of turns) {
    const next = [...parts, turn.body].join("\n\n");
    if (parts.length > 0 && next.length > CONVERSATION_PROMPT_CHARS) break;
    parts.push(turn.body);
    sent.push(turn.eventKey);
  }
  const prompt = clip(parts.join("\n\n"), CONVERSATION_PROMPT_CHARS);
  if (prompt.trim() === "") return;
  await store.transaction(function* (q) {
    if (!talk.start(item.id, item.sessionKey!, prompt)) return;
    yield* markLinearCommentsDeliveredSteps(
      q,
      batch.map((comment) => comment.commentId),
      { via: "follow_up", itemVersion: item.version, now },
    );
    if (sent.length > 0) yield* applyLinearTurnsSteps(q, item.sessionKey!, sent, item.id);
  });
}

async function postConversationReplies(
  store: Db,
  itemId: string,
  talk: LinearConversations,
  caps: LinearCommentCapabilities,
): Promise<boolean> {
  const now = caps.now();
  let posted = false;
  for (const turn of await talk.open(itemId)) {
    if (turn.result === null && !turn.expired) continue;
    const plan = turn.result?.startWork;
    const left = plan ? await leftMergeQueue(store, itemId, caps) : true;
    const job = { ready: false };
    await store.transaction(function* (q) {
      const item = yield* getWorkItemSteps(q, itemId);
      const restarted =
        plan !== undefined && left && item !== null && canConverse(item)
          ? yield* restartSteps(q, item, {
              reason: "follow_up",
              body: `${START_WORK_HANDOFF}\n\n${plan}`,
              jobKey: `start-work:${turn.commandId}`,
              now,
            })
          : null;
      job.ready = restarted?.armed === true;
      const started = restarted !== null;
      const bodies = plan
        ? [
            ...(turn.result!.replies ?? []),
            started ? `${START_WORK_RESPONSE}${plan}` : START_WORK_REFUSED,
          ]
        : conversationReplies(turn.result);
      for (const [index, body] of bodies.entries())
        yield* enqueueOutboxOnceSteps(q, {
          target: "linear",
          op: "activity",
          orderingKey: turn.sessionId,
          idempotencyKey: `conversation:${turn.commandId}:${index}`,
          payload: {
            sessionId: turn.sessionId,
            kind: "response",
            body: publicToolText(body),
            id: crypto.randomUUID(),
          },
          now,
        });
      talk.finish(turn.commandId);
    });
    if (job.ready) emitJobReady(store);
    posted = true;
  }
  return posted;
}

/** A plan's work turn needs the pull request out of GitHub's merge queue first, as a comment does. */
async function leftMergeQueue(
  store: Db,
  itemId: string,
  caps: LinearCommentCapabilities,
): Promise<boolean> {
  const item = await store.run((q) => getWorkItemSteps(q, itemId));
  const pull =
    item?.state === "merge_queue"
      ? await store.run((q) => getItemPullRequestSteps(q, itemId))
      : null;
  if (item === null || pull === null) return true;
  const left = await caps.leaveMergeQueue(item, pull.pullNumber);
  return left === "left" || left === "not_queued";
}

function conversationReplies(result: LinearConversationTurn["result"]): string[] {
  if (result === null || result.timedOut)
    return [...(result?.replies ?? []), CONVERSATION_TIMEOUT_REPLY];
  if (result.replies?.length) return result.replies;
  return result.text.trim() === "" ? [CONVERSATION_EMPTY_REPLY] : [result.text.trim()];
}

export type LinearCommentBrief = {
  text: string;
  comments: { commentId: string; updatedAtMs: number }[];
};

/** Synchronous until `Orchestrator.linearCommentBrief` can await it. */
export function linearCommentBrief(
  db: Database,
  item: WorkItemRecord,
  caps: Pick<LinearCommentCapabilities, "now" | "policy">,
): LinearCommentBrief | null {
  return settled(sqliteDb(db).transaction((q) => linearCommentBriefSteps(q, item, caps)));
}

function* linearCommentBriefSteps(
  q: Q,
  item: WorkItemRecord,
  caps: Pick<LinearCommentCapabilities, "now" | "policy">,
): Steps<LinearCommentBrief | null> {
  const batch = fitLinearComments(
    (yield* currentSteps(q, item, yield* pendingLinearCommentsSteps(q, item.id), caps)).kept,
  );
  const text = linearCommentSection(batch, item.linearIdentifier);
  return text === null
    ? null
    : {
        text,
        comments: batch.map((comment) => ({
          commentId: comment.commentId,
          updatedAtMs: comment.updatedAtMs,
        })),
      };
}

/** Synchronous until `Orchestrator.settleLinearCommentBrief` can await it. */
export function settleLinearCommentBrief(
  db: Database,
  item: WorkItemRecord,
  brief: LinearCommentBrief,
  options: { now: number; wait?: PullFeedbackWait },
): void {
  const store = sqliteDb(db);
  const gathered = settled(
    store.transaction((q) => settleLinearCommentBriefSteps(q, item, brief, options)),
  );
  if (gathered) emitJobReady(store);
}

function* settleLinearCommentBriefSteps(
  q: Q,
  item: WorkItemRecord,
  brief: LinearCommentBrief,
  options: { now: number; wait?: PullFeedbackWait },
): Steps<boolean> {
  const seen: string[] = [];
  for (const entry of brief.comments)
    if ((yield* getLinearCommentSteps(q, entry.commentId))?.updatedAtMs === entry.updatedAtMs)
      seen.push(entry.commentId);
  yield* markLinearCommentsDeliveredSteps(q, seen, {
    via: "brief",
    itemVersion: item.version,
    now: options.now,
  });
  const left = yield* pendingLinearCommentsSteps(q, item.id);
  if (
    left.length === 0 ||
    isTerminalWorkItemState((yield* getWorkItemSteps(q, item.id))?.state ?? "cancelled")
  )
    return false;
  return yield* gatherLinearCommentsSteps(
    q,
    item.id,
    options.now,
    options.wait ?? DEFAULT_PULL_FEEDBACK_WAIT,
    `linear-comments:${item.id}:${left[0]!.commentId}:${item.version}`,
  );
}

export function fitLinearComments(
  comments: readonly LinearCommentRecord[],
  required = 1,
): LinearCommentRecord[] {
  const fitted: LinearCommentRecord[] = [];
  for (const comment of comments) {
    const next = [...fitted, comment];
    const rendered = linearCommentSection(next, "");
    if (fitted.length >= required && rendered !== null && rendered.length > SECTION_CHARS) break;
    fitted.push(comment);
  }
  return fitted;
}

export function linearCommentSection(
  comments: readonly LinearCommentRecord[],
  identifier: string,
): string | null {
  const entries = comments.filter((comment) => comment.body.trim() !== "");
  if (entries.length === 0) return null;
  const lines = [`New comments on the Linear issue ${identifier}.`, ""];
  entries.forEach((comment, index) => {
    lines.push(`${index + 1}. ${who(comment)} at ${new Date(comment.createdAtMs).toISOString()}:`);
    lines.push(indent(clip(comment.body.trim(), COMMENT_CHARS)), "");
  });
  lines.push(LINEAR_COMMENT_INSTRUCTION);
  return lines.join("\n");
}

function* currentSteps(
  q: Q,
  item: WorkItemRecord,
  comments: readonly LinearCommentRecord[],
  caps: Pick<LinearCommentCapabilities, "now" | "policy">,
): Steps<{ kept: LinearCommentRecord[]; unknown: boolean }> {
  const kept: LinearCommentRecord[] = [];
  let unknown = false;
  for (const comment of comments) {
    const reason = yield* staleReasonSteps(q, item, comment, caps.policy);
    if (reason === null) kept.push(comment);
    else if (reason === "unknown") unknown = true;
    else
      yield* settleLinearCommentsSteps(q, [comment.commentId], {
        state: reason === "not_member" ? "rejected" : "ignored",
        reason,
        now: caps.now(),
      });
  }
  return { kept, unknown };
}

function* staleReasonSteps(
  q: Q,
  item: WorkItemRecord,
  comment: LinearCommentRecord,
  policy: LinearCommentPolicy,
): Steps<string | null> {
  if (comment.sessionId === null || item.sessionKey !== comment.sessionId) return "superseded";
  const session = yield* getLinearSessionSteps(q, comment.sessionId);
  if (session === null || session.stoppedAt !== null) return "session_stopped";
  if (yield* linearStoppedAfterSteps(q, comment.sessionId, comment.generation ?? 0))
    return "session_stopped";
  if (yield* inAgentSessionSteps(q, comment, policy.appUserId)) return "agent_session";
  if (policy.recheck && comment.authorId !== null) {
    const teamId = (yield* getLinearSessionInstallationSteps(q, comment.sessionId))?.teamId ?? null;
    const actors =
      comment.authority === "agent"
        ? comment.onBehalfOf === null
          ? []
          : [comment.onBehalfOf]
        : [comment.authorId];
    if (comment.authority === "agent" && !policy.agents.includes(comment.authorId))
      return "not_member";
    const verdicts = actors.map((id) => policy.recheck!({ id, teamId }));
    if (verdicts.includes(false)) return "not_member";
    if (verdicts.includes(null)) return "unknown";
  }
  return null;
}

function* inAgentSessionSteps(
  q: Q,
  comment: LinearCommentRecord,
  appUserId: string | null,
): Steps<boolean> {
  if (
    comment.parentId !== null &&
    appUserId !== null &&
    (yield* linearCommentAuthorSteps(q, comment.parentId)) === appUserId
  )
    return true;
  const ids =
    comment.parentId === null ? [comment.commentId] : [comment.commentId, comment.parentId];
  for (const id of ids)
    if (yield* commentOpenedAgentSessionSteps(q, comment.issueId, id)) return true;
  return false;
}

function who(comment: LinearCommentRecord): string {
  if (comment.authority === "agent")
    return comment.onBehalfOf === null
      ? `Agent ${comment.authorId}`
      : `Agent ${comment.authorId} for ${comment.onBehalfOf}`;
  return `Linear user ${comment.authorId}`;
}

function count(comments: readonly LinearCommentRecord[]): string {
  return comments.length === 1 ? "the comment" : `${comments.length} comments`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}
