export function handoffNote(input: {
  question: string;
  answer: string;
  options?: readonly (string | { label?: string; value: string })[];
}): string {
  return [
    "Handoff from the previous session.",
    `Question: ${input.question}`,
    ...(input.options?.length ? [`Options: ${JSON.stringify(input.options)}`] : []),
    `Answer: ${input.answer}`,
    "Continue from the latest commit in this worktree and use the answer above. Do not ask again.",
  ].join("\n");
}
