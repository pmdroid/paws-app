import { pawsQuestionMarker } from "../questions";

/** Living status comments and question threads start with this prefix. */
export const PAWS_PREFIX = "Paws:";

/** At most one edit of the status comment in this window. */
export const STATUS_EDIT_INTERVAL_MS = 5_000;

/** A human comment whose own line is this command stops the item. */
export const STOP_COMMAND = "/paws stop";

/** Default Linear mode for a local process with no public URL. */
export const DEFAULT_LINEAR_MODE = "comments" as const;

export type LinearMode = typeof DEFAULT_LINEAR_MODE | "agent-session";

const MARKER_RE = /<!--\s*paws:q:([^\s>]+)\s*-->/;

export function questionMarker(questionId: string): string {
  return pawsQuestionMarker(questionId);
}

export function readQuestionMarker(body: string): string | null {
  const match = MARKER_RE.exec(body);
  return match?.[1] ?? null;
}

/** Prefix a status or evidence body once. */
export function formatPawsText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Paws comment body is empty");
  if (trimmed.startsWith(PAWS_PREFIX)) return trimmed;
  return `${PAWS_PREFIX} ${trimmed}`;
}

export function isPawsText(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith(PAWS_PREFIX) || trimmed.includes("<!-- paws:q:");
}

export function isStopCommand(body: string): boolean {
  return body.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === STOP_COMMAND || trimmed.startsWith(`${STOP_COMMAND} `);
  });
}

/** Question thread root. The marker is how a later reply is matched back. */
export function formatQuestion(input: {
  questionId: string;
  title?: string;
  body: string;
  options?: readonly string[];
}): string {
  const lines: string[] = [];
  const title = input.title?.trim() ?? "";
  lines.push(title.length > 0 ? formatPawsText(title) : PAWS_PREFIX);
  const body = input.body.trim();
  if (body.length > 0) {
    lines.push("", body);
  }
  const options = input.options ?? [];
  if (options.length > 0) {
    lines.push("");
    for (let index = 0; index < options.length; index++) {
      lines.push(`${index + 1}. ${options[index] ?? ""}`);
    }
    lines.push("", "Reply with a number, or answer in your own words.");
  }
  lines.push("", questionMarker(input.questionId));
  return lines.join("\n");
}
