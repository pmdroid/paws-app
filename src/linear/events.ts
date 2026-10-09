export type LinearEventAction = "created" | "prompted" | "other";

export type LinearEventSource = "webhook" | "poll";

/** One Linear agent-session event after it has been verified or polled. */
export type AcceptedLinearEvent = {
  dedupeKey: string;
  deliveryId: string | null;
  source: LinearEventSource;
  action: LinearEventAction;
  sessionId: string | null;
  issueId: string | null;
  activityId: string | null;
  body: string | null;
  signal: string | null;
  updatedAtMs: number;
  payload: string;
};

export function sessionCreatedKey(sessionId: string): string {
  return `session:${sessionId}:created`;
}

export function activityKey(activityId: string): string {
  return `activity:${activityId}`;
}

export function deliveryKey(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}
