/** Body of a Linear elicitation. Options ride on the `select` signal; free text stays open. */
export function elicitationBody(question: string, context?: string): string {
  const lines = [question.trim()];
  if (context !== undefined && context.trim() !== "") {
    lines.push("", context.trim());
  }
  lines.push("", "Reply with one of the options, or answer in your own words.");
  return lines.join("\n");
}

/** Prompt prefix for a fresh ACP session after the team answers. */
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
