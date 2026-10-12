import { isRecord, readString } from "./read";

export type LinearSessionContext = {
  promptContext: string | null;
  issue: unknown;
  comment: unknown;
  previousComments: readonly unknown[];
  guidance: readonly unknown[];
};

export function parseLinearSessionContext(payload: string): LinearSessionContext {
  const data: unknown = JSON.parse(payload);
  const root = isRecord(data) ? data : {};
  const session = isRecord(root["agentSession"]) ? root["agentSession"] : {};
  return {
    promptContext: readString(root, "promptContext"),
    issue: session["issue"] ?? null,
    comment: session["comment"] ?? null,
    previousComments: Array.isArray(root["previousComments"]) ? root["previousComments"] : [],
    guidance: Array.isArray(root["guidance"]) ? root["guidance"] : [],
  };
}

export function renderLinearSessionContext(context: LinearSessionContext): string {
  const instructions =
    "Linear session instructions follow. Apply workspace and team guidance, with the nearest team-specific guidance taking precedence when instructions conflict. Previous comments provide conversation context; the comment that initiated this session provides the user's request.";
  const structured = {
    issue: context.issue,
    comment: context.comment,
    previousComments: context.previousComments,
    guidance: context.guidance,
  };
  if (
    !context.promptContext &&
    !context.issue &&
    !context.comment &&
    !context.previousComments.length &&
    !context.guidance.length
  )
    return "";
  return [instructions, context.promptContext ?? "", JSON.stringify(structured)]
    .filter(Boolean)
    .join("\n\n");
}
