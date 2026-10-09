import { systemClock, type Clock } from "../core";
import type { CommentBoard, CommentWrite, IssueComment } from "./board";

export type FakeCommentPost = {
  issueId: string;
  parentId?: string | null;
  body: string;
  userId?: string | null;
  botId?: string | null;
  createdAtMs?: number;
};

export type FakeCommentBoard = CommentBoard & {
  comments: IssueComment[];
  readonly creates: number;
  readonly updates: number;
  /** A comment Paws did not write. Used to simulate a teammate. */
  post(input: FakeCommentPost): IssueComment;
};

export function createFakeCommentBoard(options?: {
  clock?: Clock;
  selfUserId?: string;
}): FakeCommentBoard {
  const clock = options?.clock ?? systemClock;
  const selfUserId = options?.selfUserId ?? "paws";
  const comments: IssueComment[] = [];
  const counts = { creates: 0, updates: 0 };
  let nextId = 1;
  let nextSeq = 1;

  function insert(input: {
    issueId: string;
    parentId: string | null;
    body: string;
    userId: string | null;
    botId: string | null;
    createdAtMs: number;
  }): IssueComment {
    const comment: IssueComment = {
      id: `cmt-${nextId}`,
      issueId: input.issueId,
      parentId: input.parentId,
      body: input.body,
      userId: input.userId,
      botId: input.botId,
      createdAtMs: input.createdAtMs,
      seq: nextSeq,
    };
    nextId += 1;
    nextSeq += 1;
    comments.push(comment);
    return comment;
  }

  return {
    comments,
    get creates() {
      return counts.creates;
    },
    get updates() {
      return counts.updates;
    },
    async create(input: CommentWrite) {
      counts.creates += 1;
      return insert({
        issueId: input.issueId,
        parentId: input.parentId,
        body: input.body,
        userId: selfUserId,
        botId: null,
        createdAtMs: clock.now(),
      });
    },
    async update(input) {
      const found = comments.find((comment) => comment.id === input.id);
      if (found === undefined) throw new Error(`unknown comment ${input.id}`);
      counts.updates += 1;
      found.body = input.body;
      return found;
    },
    async list(issueId) {
      return comments.filter((comment) => comment.issueId === issueId).sort(compareComments);
    },
    post(input) {
      return insert({
        issueId: input.issueId,
        parentId: input.parentId ?? null,
        body: input.body,
        userId: input.userId ?? null,
        botId: input.botId ?? null,
        createdAtMs: input.createdAtMs ?? clock.now(),
      });
    },
  };
}

function compareComments(left: IssueComment, right: IssueComment): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return left.id.localeCompare(right.id);
}
