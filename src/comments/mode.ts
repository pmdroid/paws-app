import { systemClock, type Clock, type CommandBus, type ItemId, type LinearCommand } from "../core";
import type { Elicitation, ProgressUpdate, TrackerAdapter } from "../linear";
import type { AskTeamInput, QuestionChannel, StoredQuestion, TeamAnswer } from "../questions";
import type { CommentBoard, IssueComment } from "./board";
import {
  STATUS_EDIT_INTERVAL_MS,
  PAWS_PREFIX,
  formatPawsText,
  formatQuestion,
  isPawsText,
  isStopCommand,
  readQuestionMarker,
} from "./format";

export type CommentBinding = {
  itemId: ItemId;
  linearIssueId: string;
  sessionId?: string;
};

export type CommentRunPhase = "idle" | "running" | "parked" | "resumed" | "stopped";

export type CommentSync = {
  resumed: readonly TeamAnswer[];
  stopped: readonly { itemId: string; requestedAt: number }[];
};

export type CommentModeOptions = {
  board: CommentBoard;
  clock?: Clock;
  /** Linear user id of the personal API key. Comments from this user are Paws when selfDetection is `"user"`. */
  selfUserId?: string;
  commands?: CommandBus;
  onResume?: (answer: TeamAnswer) => void | Promise<void>;
  onStop?: (command: LinearCommand) => void | Promise<void>;
};

export type CommentMode = Pick<TrackerAdapter, "postProgress" | "askQuestion"> &
  QuestionChannel & {
    bind(binding: CommentBinding): void;
    /** Read issue comments. Applies a pending status edit once the window allows. */
    sync(linearIssueId: string, pending?: StoredQuestion | null): Promise<CommentSync>;
    phase(itemId: string): CommentRunPhase;
    /** Resolves when a human reply resumes this question. Rejects if the item stops. */
    wait(questionId: string): Promise<TeamAnswer>;
    answers: TeamAnswer[];
  };

type Binding = {
  itemId: string;
  linearIssueId: string;
  sessionId: string | null;
  boundAtMs: number;
  stopped: boolean;
};

type StatusSlot = {
  itemId: string;
  linearIssueId: string;
  commentId: string | null;
  lastWriteMs: number;
  written: string | null;
  pending: string | null;
};

type OpenQuestion = {
  questionId: string;
  itemId: string;
  linearIssueId: string;
  commentId: string;
  createdAtMs: number;
  seq: number;
  state: "parked" | "resumed" | "stopped";
  answer: TeamAnswer | null;
};

type Waiter = {
  resolve: (answer: TeamAnswer) => void;
  reject: (error: Error) => void;
};

const DONE_STATUS = "Done.";

/**
 * Comment mode. Progress is one edited `Paws:` comment per item.
 * `response` is a final comment. `ask` posts a question and parks the run
 * until a later comment that Paws did not write.
 *
 * Linear (`selfDetection: "user"`) answers in the question thread.
 * GitHub (`selfDetection: "marker"`) answers with the first later issue comment,
 * because issue comments are a flat list and Paws posts as the developer.
 */
export function createCommentMode(options: CommentModeOptions): CommentMode {
  const clock = options.clock ?? systemClock;
  const selfUserId = options.selfUserId ?? "paws";
  const items = new Map<string, Binding>();
  const slots = new Map<string, StatusSlot>();
  const questions = new Map<string, OpenQuestion>();
  const waiters = new Map<string, Waiter>();
  const written = new Set<string>();
  const answers: TeamAnswer[] = [];
  let nextQuestion = 1;

  function bind(binding: CommentBinding): void {
    const existing = items.get(binding.itemId);
    if (existing !== undefined) {
      existing.linearIssueId = binding.linearIssueId;
      if (binding.sessionId !== undefined) existing.sessionId = binding.sessionId;
      return;
    }
    items.set(binding.itemId, {
      itemId: binding.itemId,
      linearIssueId: binding.linearIssueId,
      sessionId: binding.sessionId ?? null,
      boundAtMs: clock.now(),
      stopped: false,
    });
  }

  function resolveKey(key: string): Binding {
    const direct = items.get(key);
    if (direct !== undefined) return direct;
    for (const item of items.values()) {
      if (item.sessionId === key || item.linearIssueId === key) return item;
    }
    throw new Error(`No comment-mode issue is bound for ${key}`);
  }

  function slotFor(binding: Binding): StatusSlot {
    const existing = slots.get(binding.itemId);
    if (existing !== undefined) {
      existing.linearIssueId = binding.linearIssueId;
      return existing;
    }
    const created: StatusSlot = {
      itemId: binding.itemId,
      linearIssueId: binding.linearIssueId,
      commentId: null,
      lastWriteMs: 0,
      written: null,
      pending: null,
    };
    slots.set(binding.itemId, created);
    return created;
  }

  async function flushSlot(slot: StatusSlot, now: number): Promise<void> {
    if (slot.pending === null) return;
    if (slot.commentId === null) {
      const created = await options.board.create({
        issueId: slot.linearIssueId,
        parentId: null,
        body: slot.pending,
      });
      written.add(created.id);
      slot.commentId = created.id;
      slot.written = slot.pending;
      slot.pending = null;
      slot.lastWriteMs = now;
      return;
    }
    if (slot.pending === slot.written) {
      slot.pending = null;
      return;
    }
    if (now - slot.lastWriteMs < STATUS_EDIT_INTERVAL_MS) return;
    await options.board.update({ id: slot.commentId, body: slot.pending });
    slot.written = slot.pending;
    slot.pending = null;
    slot.lastWriteMs = now;
  }

  async function postStatus(binding: Binding, body: string): Promise<void> {
    const slot = slotFor(binding);
    slot.pending = formatPawsText(body);
    await flushSlot(slot, clock.now());
  }

  async function postEvidence(binding: Binding, body: string): Promise<void> {
    const slot = slotFor(binding);
    if (slot.commentId === null) {
      slot.pending = formatPawsText(DONE_STATUS);
      await flushSlot(slot, clock.now());
    }
    const parentId = slot.commentId;
    if (parentId === null) throw new Error("status comment was not created");
    const created = await options.board.create({
      issueId: binding.linearIssueId,
      parentId,
      body: formatPawsText(body),
    });
    written.add(created.id);
  }

  async function postProgress(update: ProgressUpdate): Promise<void> {
    const binding = resolveKey(update.sessionId);
    if (binding.stopped) return;
    if (update.kind === "response") {
      await postEvidence(binding, update.body);
      return;
    }
    if (update.kind === "elicitation") {
      await askQuestion({ sessionId: update.sessionId, body: update.body });
      return;
    }
    await postStatus(binding, update.body);
  }

  async function ask(input: AskTeamInput): Promise<{ questionId: string }> {
    const binding = resolveKey(input.itemId);
    if (binding.stopped) throw new Error(`item ${binding.itemId} is stopped`);
    const questionId = input.questionId ?? `q-${nextQuestion}`;
    nextQuestion += 1;
    const created = await options.board.create({
      issueId: binding.linearIssueId,
      parentId: null,
      body: formatQuestion({
        questionId,
        title: input.title,
        body: input.body,
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
    });
    written.add(created.id);
    questions.set(questionId, {
      questionId,
      itemId: binding.itemId,
      linearIssueId: binding.linearIssueId,
      commentId: created.id,
      createdAtMs: created.createdAtMs,
      seq: created.seq,
      state: "parked",
      answer: null,
    });
    return { questionId };
  }

  async function askQuestion(question: Elicitation): Promise<void> {
    const binding = resolveKey(question.sessionId);
    await ask({
      itemId: binding.itemId,
      title: "Question",
      body: question.body,
      ...(question.questionId === undefined ? {} : { questionId: question.questionId }),
      ...(question.options === undefined ? {} : { options: question.options }),
    });
  }

  async function deliverAnswer(input: TeamAnswer): Promise<void> {
    await takeAnswer(input);
  }

  async function takeAnswer(input: TeamAnswer): Promise<boolean> {
    const open = questions.get(input.questionId);
    if (open === undefined) {
      answers.push(input);
      return false;
    }
    if (open.state !== "parked") return false;
    const binding = items.get(open.itemId);
    if (binding?.stopped) {
      open.state = "stopped";
      return false;
    }
    open.state = "resumed";
    open.answer = input;
    answers.push(input);
    const waiter = waiters.get(input.questionId);
    waiters.delete(input.questionId);
    waiter?.resolve(input);
    await options.onResume?.(input);
    return true;
  }

  function wait(questionId: string): Promise<TeamAnswer> {
    const open = questions.get(questionId);
    if (open?.state === "resumed" && open.answer !== null) return Promise.resolve(open.answer);
    if (open?.state === "stopped") return Promise.reject(new Error("stopped"));
    return new Promise((resolve, reject) => {
      waiters.set(questionId, { resolve, reject });
    });
  }

  function phase(itemId: string): CommentRunPhase {
    const item = items.get(itemId);
    if (item === undefined) return "idle";
    if (item.stopped) return "stopped";
    const mine = [...questions.values()].filter((question) => question.itemId === itemId);
    if (mine.some((question) => question.state === "parked")) return "parked";
    if (mine.some((question) => question.state === "resumed")) return "resumed";
    return "running";
  }

  async function stopItem(
    item: Binding,
    requestedAt: number,
  ): Promise<{
    itemId: string;
    requestedAt: number;
  } | null> {
    if (item.stopped) return null;
    item.stopped = true;
    for (const open of questions.values()) {
      if (open.itemId !== item.itemId || open.state !== "parked") continue;
      open.state = "stopped";
    }
    const command: LinearCommand = {
      type: "stop",
      itemId: item.itemId,
      source: "linear",
      requestedAt,
    };
    options.commands?.emit(command);
    for (const [questionId, waiter] of waiters) {
      const open = questions.get(questionId);
      if (open?.itemId !== item.itemId) continue;
      waiters.delete(questionId);
      waiter.reject(new Error("stopped"));
    }
    await options.onStop?.(command);
    return { itemId: item.itemId, requestedAt };
  }

  function isPaws(comment: IssueComment): boolean {
    if (written.has(comment.id)) return true;
    if (hasPawsMarker(comment.body)) return true;
    if (comment.botId !== null && comment.botId === selfUserId) return true;
    return isPawsText(comment.body);
  }

  async function sync(
    linearIssueId: string,
    pending?: StoredQuestion | null,
  ): Promise<CommentSync> {
    const resumed: TeamAnswer[] = [];
    const stopped: { itemId: string; requestedAt: number }[] = [];
    const now = clock.now();
    for (const slot of slots.values()) {
      if (slot.linearIssueId === linearIssueId) await flushSlot(slot, now);
    }
    const comments = await options.board.list(linearIssueId);
    if (pending != null) {
      const roots = comments.filter((comment) => comment.body.trim().startsWith(PAWS_PREFIX));
      const root =
        roots.find((comment) => readQuestionMarker(comment.body) === pending.id) ??
        roots.find((comment) => {
          const marker = readQuestionMarker(comment.body);
          return (
            marker !== null &&
            /^q-\d+$/.test(marker) &&
            comment.createdAtMs >= Math.floor(pending.createdAt / 1_000) * 1_000 &&
            comment.body.includes(pending.body)
          );
        });
      if (root !== undefined) {
        for (const [id, question] of questions) {
          if (question.commentId === root.id) questions.delete(id);
        }
        questions.set(pending.id, {
          questionId: pending.id,
          itemId: resolveKey(linearIssueId).itemId,
          linearIssueId,
          commentId: root.id,
          createdAtMs: root.createdAtMs,
          seq: root.seq,
          state: "parked",
          answer: null,
        });
      }
    }
    for (const item of items.values()) {
      if (item.linearIssueId !== linearIssueId || item.stopped) continue;
      const stop = earliestStop(comments, item, isPaws);
      if (stop === null) continue;
      const command = await stopItem(item, stop.createdAtMs);
      if (command !== null) stopped.push(command);
    }
    for (const open of questions.values()) {
      if (open.linearIssueId !== linearIssueId || open.state !== "parked") continue;
      const reply = firstAnswer(comments, open, isPaws);
      if (reply === null) continue;
      const answer: TeamAnswer = {
        questionId: open.questionId,
        answer: reply.body.trim(),
        answeredBy: reply.userId ?? reply.botId ?? "unknown",
      };
      if (await takeAnswer(answer)) resumed.push(answer);
    }
    return { resumed, stopped };
  }

  return {
    bind,
    postProgress,
    askQuestion,
    ask,
    deliverAnswer,
    sync,
    phase,
    wait,
    answers,
  };
}

/** Swap the activity methods. Epic reads and workflow state stay on `tracker`. */
export function withCommentActivities(
  tracker: TrackerAdapter,
  mode: Pick<TrackerAdapter, "postProgress" | "askQuestion">,
): TrackerAdapter {
  return {
    ...(tracker.getSession ? { getSession: tracker.getSession.bind(tracker) } : {}),
    ...(tracker.listSessionActivities
      ? { listSessionActivities: tracker.listSessionActivities.bind(tracker) }
      : {}),
    ...(tracker.issueRepositorySuggestions
      ? { issueRepositorySuggestions: tracker.issueRepositorySuggestions.bind(tracker) }
      : {}),
    loadEpic: (linearIssueId) => tracker.loadEpic(linearIssueId),
    listDeps: (linearIssueId) => tracker.listDeps(linearIssueId),
    setStatus: (update) => tracker.setStatus(update),
    postProgress: (update) => mode.postProgress(update),
    askQuestion: (question) => mode.askQuestion(question),
  };
}

function earliestStop(
  comments: readonly IssueComment[],
  item: Binding,
  isPaws: (comment: IssueComment) => boolean,
): IssueComment | null {
  let found: IssueComment | null = null;
  for (const comment of comments) {
    if (comment.createdAtMs < item.boundAtMs) continue;
    if (isPaws(comment) || !isStopCommand(comment.body)) continue;
    if (
      found === null ||
      comment.createdAtMs < found.createdAtMs ||
      (comment.createdAtMs === found.createdAtMs && comment.seq < found.seq)
    ) {
      found = comment;
    }
  }
  return found;
}

function firstAnswer(
  comments: readonly IssueComment[],
  question: OpenQuestion,
  isPaws: (comment: IssueComment) => boolean,
): IssueComment | null {
  const replies = comments
    .filter((comment) => comment.parentId === question.commentId)
    .filter((comment) => isLaterThan(comment, question))
    .filter((comment) => !isPaws(comment))
    .filter((comment) => !isStopCommand(comment.body))
    .filter((comment) => comment.body.trim().length > 0)
    .sort(compareComments);
  return replies[0] ?? null;
}

function hasPawsMarker(body: string): boolean {
  return /<!--\s*paws\b/.test(body);
}

function isLaterThan(comment: IssueComment, question: OpenQuestion): boolean {
  if (comment.id === question.commentId) return false;
  if (comment.createdAtMs !== question.createdAtMs)
    return comment.createdAtMs > question.createdAtMs;
  return question.seq > 0 && comment.seq > question.seq;
}

function compareComments(left: IssueComment, right: IssueComment): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return left.id.localeCompare(right.id);
}
