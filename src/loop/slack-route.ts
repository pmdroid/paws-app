import type { OutboxRow } from "../db";

export const SLACK_ROUTED_NOTE = "Paws continued this in the Slack thread the issue started in.";
export const SLACK_ASKED_NOTE =
  "Paws asked its question in the Slack thread the issue started in; answer it there.";

export function slackRouted(
  message: OutboxRow,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const elicitation = message.op === "elicitation";
  const thought = elicitation || payload["kind"] === "thought";
  return {
    ...payload,
    sessionId: payload["sessionId"] ?? message.orderingKey,
    kind: thought ? "thought" : payload["kind"],
    body: elicitation ? SLACK_ASKED_NOTE : SLACK_ROUTED_NOTE,
    ...(thought && !elicitation ? { ephemeral: true } : {}),
  };
}
