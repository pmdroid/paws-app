import type { SlackFollowUp, SlackFollowUpRefusal, SlackFollowUpTrigger } from "../db";

const FENCE = "```paws-follow-up";
const BLOCK = /^```paws-follow-up[ \t]*\n([\s\S]*?)\n?```\s*$/;
const FIELDS = new Set(["purpose", "after_minutes", "work", "on"]);

export type SlackFollowUpRequest =
  | { purpose: string; afterMinutes: number }
  | { purpose: string; work: string; on: "ended" | "pull_request" };

export const SLACK_FOLLOW_UP_INSTRUCTIONS =
  ' When the person asks you to tell them about something later, or you promise to check back, end your reply with one fenced block tagged `paws-follow-up` holding one JSON object: `{"purpose": "...", "after_minutes": 20}` for a check after a time, or `{"purpose": "...", "work": "PAS-1", "on": "ended" | "pull_request"}` to come back when that work ends or opens its pull request. Only work filed from this thread can be watched, at most 24 hours ahead, and only one follow-up can be pending in this thread. Say in your reply what you will follow up on. At most one block. Don\'t schedule anything the person didn\'t ask for or agree to. The block comes before the `paws-notes` block.';

function request(value: unknown): SlackFollowUpRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (!Object.keys(fields).every((name) => FIELDS.has(name))) return null;
  const { purpose, after_minutes: after, work, on } = fields;
  if (typeof purpose !== "string") return null;
  if (after !== undefined) {
    if (work !== undefined || on !== undefined) return null;
    return typeof after === "number" && Number.isFinite(after)
      ? { purpose, afterMinutes: after }
      : null;
  }
  if (typeof work !== "string" || !work.trim()) return null;
  if (on !== "ended" && on !== "pull_request") return null;
  return { purpose, work: work.trim(), on };
}

export function splitSlackFollowUp(text: string): {
  answer: string;
  request: SlackFollowUpRequest | null;
} {
  const at = text.indexOf(FENCE);
  if (at < 0) return { answer: text, request: null };
  const answer = text.slice(0, at).trimEnd();
  const block = BLOCK.exec(text.slice(at));
  if (!block || block[1]!.includes("```")) return { answer, request: null };
  try {
    return { answer, request: request(JSON.parse(block[1]!)) };
  } catch {
    return { answer, request: null };
  }
}

export const slackFollowUpShortId = (id: string) => id.slice(-6).toLowerCase();

export function slackFollowUpWhen(trigger: SlackFollowUpTrigger, now: number): string {
  if (trigger.type === "work")
    return trigger.on === "ended"
      ? `when ${trigger.identifier} ends`
      : `when ${trigger.identifier} opens its pull request`;
  return `in about ${Math.max(1, Math.round((trigger.at - now) / 60_000))} minutes`;
}

export function slackFollowUpLine(followUp: SlackFollowUp, now: number): string {
  const id = slackFollowUpShortId(followUp.id);
  const when = slackFollowUpWhen(followUp.trigger, now);
  return `_Follow-up ${id}: ${when}. Cancel with @Paws cancel ${id}._`;
}

const REASONS: Record<SlackFollowUpRefusal, string> = {
  purpose_empty: "it had no purpose",
  purpose_too_long: "its purpose is longer than 500 characters",
  timer_too_soon: "it is less than 5 minutes away",
  timer_too_late: "it is more than 24 hours away",
  thread_busy: "this thread already has a follow-up pending",
  member_limit: "you already have 10 follow-ups pending",
};

export const slackFollowUpRefused = (reason: SlackFollowUpRefusal) =>
  `Paws couldn't schedule that follow-up: ${REASONS[reason]}.`;

export function slackFollowUpsText(followUps: readonly SlackFollowUp[], now: number): string {
  if (!followUps.length) return "No follow-ups pending here.";
  const lines = followUps.map(
    (followUp) =>
      `- \`${slackFollowUpShortId(followUp.id)}\` ${slackFollowUpWhen(followUp.trigger, now)}: ${followUp.purpose}`,
  );
  return `Your follow-ups here:\n${lines.join("\n")}`;
}
