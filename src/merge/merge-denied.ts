import type { StoredQuestion } from "../questions";

export const RETRY_MERGE = "Retry merge";

export const MERGE_DENIAL_LIMIT = 3;

export function retriesMerge(question: Pick<StoredQuestion, "options" | "answer">): boolean {
  const answer = (question.answer ?? "").trim().toLowerCase();
  return (
    question.options.includes(RETRY_MERGE) &&
    (answer === "retry" || answer === RETRY_MERGE.toLowerCase())
  );
}

export function mergeDeniedQuestion(denial: {
  status: number | undefined;
  reason: string | undefined;
  head: string;
  pullUrl: string | null;
}): string {
  return [
    `GitHub refused to merge the pull request${denial.status === undefined ? "" : ` with status ${denial.status}`}.`,
    denial.reason ? `GitHub says: ${denial.reason}` : "GitHub gave no reason.",
    ...(denial.pullUrl ? [`Pull request: ${denial.pullUrl}`] : []),
    `Head: ${denial.head}.`,
    "This is usually fixed on GitHub: approve the required review, or change the branch protection or the allowed merge methods.",
    `Then choose ${RETRY_MERGE}, or reply retry, to merge this head again without the agent. Reply with guidance to send the task back to its agent.`,
  ].join("\n\n");
}
