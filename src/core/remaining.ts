export type RemainingPart = { title: string; scope: string };

export const MAX_REMAINING_PARTS = 3;
const REMAINING_TITLE_MAX_LENGTH = 120;
const REMAINING_SCOPE_MAX_LENGTH = 4000;

export function parseRemainingParts(value: unknown): RemainingPart[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("remaining must be a list of parts");
  if (value.length > MAX_REMAINING_PARTS)
    throw new Error(
      `remaining lists at most ${MAX_REMAINING_PARTS} parts, and this lists ${value.length}. Ship this pull request with ${MAX_REMAINING_PARTS} parts or fewer and call ask_team about the rest.`,
    );
  return value.map((entry: unknown, index) => {
    const part = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const title = typeof part.title === "string" ? part.title.trim() : "";
    const scope = typeof part.scope === "string" ? part.scope.trim() : "";
    if (!title || title.length > REMAINING_TITLE_MAX_LENGTH || /[\r\n]/.test(title))
      throw new Error(
        `remaining part ${index + 1} needs a one-line title of at most ${REMAINING_TITLE_MAX_LENGTH} characters`,
      );
    if (!scope || scope.length > REMAINING_SCOPE_MAX_LENGTH)
      throw new Error(
        `remaining part ${index + 1} needs a scope of 1 to ${REMAINING_SCOPE_MAX_LENGTH} characters naming the files and what is left`,
      );
    return { title, scope };
  });
}

export function withLeftForLater(body: string, remaining: readonly RemainingPart[]): string {
  if (remaining.length === 0) return body;
  const parts = remaining.map((part) => `### ${part.title}\n\n${part.scope}`);
  return `${body.trim()}\n\n## Left for later\n\n${parts.join("\n\n")}`;
}
