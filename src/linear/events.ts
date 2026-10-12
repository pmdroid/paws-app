import { isRecord, readNumber, readString } from "./read";

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
  actorId?: string | null;
  activityCreatedAtMs?: number | null;
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

export function promptMetadata(payload: string): {
  actorId?: string | null;
  activityCreatedAtMs?: number | null;
} {
  const empty = {};
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return empty;
    const activity = isRecord(parsed["agentActivity"]) ? parsed["agentActivity"] : null;
    if (activity === null) {
      return {
        actorId: readString(parsed, "actorId"),
        ...(parsed["activityCreatedAtMs"] === undefined
          ? {}
          : { activityCreatedAtMs: readNumber(parsed, "activityCreatedAtMs") }),
      };
    }
    const user = isRecord(activity["user"]) ? activity["user"] : null;
    const createdAt = readString(activity, "createdAt");
    const parsedTime = createdAt === null ? NaN : Date.parse(createdAt);
    return {
      actorId: readString(activity, "userId") ?? (user === null ? null : readString(user, "id")),
      activityCreatedAtMs: Number.isFinite(parsedTime) ? parsedTime : null,
    };
  } catch {
    return empty;
  }
}
