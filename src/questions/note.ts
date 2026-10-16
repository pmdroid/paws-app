/** Body of a Linear elicitation. Options ride on the `select` signal; free text stays open. */
export function elicitationBody(question: string, context?: string): string {
  const lines = [question.trim()];
  if (context !== undefined && context.trim() !== "") {
    lines.push("", context.trim());
  }
  lines.push("", "Reply with one of the options, or answer in your own words.");
  return lines.join("\n");
}

export { handoffNote } from "../core";
