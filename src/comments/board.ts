/** One Linear issue comment, including replies (`parentId` set). */
export type IssueComment = {
  id: string;
  issueId: string;
  parentId: string | null;
  body: string;
  userId: string | null;
  botId: string | null;
  createdAtMs: number;
  /** Board-local order. Zero when the source has no stable sequence. */
  seq: number;
};

export type CommentWrite = {
  issueId: string;
  parentId: string | null;
  body: string;
};

/**
 * Comment port. The real board talks to Linear with a personal API key.
 * Tests use the in-memory fake.
 */
export interface CommentBoard {
  create(input: CommentWrite): Promise<IssueComment>;
  update(input: { id: string; body: string }): Promise<IssueComment>;
  list(issueId: string): Promise<readonly IssueComment[]>;
}
