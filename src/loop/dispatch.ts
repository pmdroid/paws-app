import type {
  ActionDetails,
  ActivityKind,
  AuthSignal,
  SelectOption,
  TrackerAdapter,
  TrackerRequestOptions,
} from "../linear";
import type { OutboxRow, OutboxDeliveryContext } from "../db";
import { prepareLinearActivity } from "../db";
import type { Database } from "bun:sqlite";

const KINDS = new Set<ActivityKind>(["thought", "action", "elicitation", "response", "error"]);

/**
 * Deliver `linear` outbox rows to the tracker.
 * `activity` / `linear.activity` post progress. `linear.catchup` runs the poller.
 */
export async function deliverLinearOutbox(
  message: OutboxRow,
  tracker: TrackerAdapter,
  catchUp: () => Promise<void>,
  context?: OutboxDeliveryContext,
  db?: Database,
): Promise<void> {
  context?.signal.throwIfAborted();
  if (context && !context.isCurrent())
    throw new Error("Linear delivery superseded by a session fence.");
  if (db && tracker.supportsActivityReconciliation) message = prepareLinearActivity(db, message);
  const payload = isRecord(message.payload) ? message.payload : {};
  const options = {
    ...(context ? { signal: context.signal, isCurrent: context.isCurrent } : {}),
    ...(message.attempts > 1 ? { reconcile: true } : {}),
  };
  if (message.op === "activity" || message.op === "linear.activity") {
    return postActivity(message, payload, tracker, options);
  }
  if (message.op === "elicitation") {
    return postElicitation(payload, tracker, options);
  }
  if (message.op === "status") {
    return postStatus(payload, tracker, options);
  }
  if (message.op === "catchup" || message.op === "linear.catchup") {
    return catchUp();
  }
  throw new Error(`unknown linear outbox op ${message.op}`);
}

async function postActivity(
  message: OutboxRow,
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  options?: TrackerRequestOptions,
): Promise<void> {
  const sessionId = readString(payload, "sessionId") ?? message.orderingKey;
  const body = readString(payload, "body") ?? readString(payload, "text");
  if (sessionId === null || sessionId.length === 0) throw new Error("activity has no session");
  if (body === null) throw new Error("activity has no body");
  const kind = readKind(payload["kind"]);
  if (kind === null) throw new Error("activity has no valid kind");
  const id = optionalString(payload, "id");
  const action = readAction(payload["action"]);
  const ephemeral = payload["ephemeral"];
  if (ephemeral !== undefined && typeof ephemeral !== "boolean") {
    throw new Error("activity ephemeral must be a boolean");
  }
  await tracker.postProgress(
    {
      sessionId,
      kind,
      body,
      ...(id === undefined ? {} : { id }),
      ...(action === undefined ? {} : { action }),
      ...(ephemeral === undefined ? {} : { ephemeral }),
    },
    options,
  );
}

async function postElicitation(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  requestOptions?: TrackerRequestOptions,
): Promise<void> {
  const sessionId = readString(payload, "sessionId");
  const body = readString(payload, "body");
  if (sessionId === null || body === null)
    throw new Error("elicitation is missing session or body");
  const options = readOptions(payload["options"]);
  const questionId = readString(payload, "questionId");
  const id = optionalString(payload, "id");
  const auth = readAuth(payload["auth"]);
  await tracker.askQuestion(
    {
      sessionId,
      body,
      ...(questionId === null ? {} : { questionId }),
      ...(id === undefined ? {} : { id }),
      ...(auth === undefined ? {} : { auth }),
      ...(options.length > 0 ? { options } : {}),
    },
    requestOptions,
  );
}

async function postStatus(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
  options?: TrackerRequestOptions,
): Promise<void> {
  const linearIssueId = readString(payload, "linearIssueId");
  const stateType = readString(payload, "stateType");
  if (linearIssueId === null || !isStateType(stateType)) {
    throw new Error("status update is missing an issue or state");
  }
  await tracker.setStatus({ linearIssueId, stateType }, options);
}

function readKind(value: unknown): ActivityKind | null {
  return typeof value === "string" && KINDS.has(value as ActivityKind)
    ? (value as ActivityKind)
    : null;
}

function readOptions(value: unknown): (string | SelectOption)[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("elicitation options must be an array");
  return value.map((option) => {
    if (typeof option === "string" && option.trim().length > 0) return option;
    if (isRecord(option)) {
      const label = optionalString(option, "label");
      const optionValue = readString(option, "value");
      if (optionValue !== null)
        return { value: optionValue, ...(label === undefined ? {} : { label }) };
    }
    throw new Error("elicitation options must be strings or label/value choices");
  });
}

function readAction(value: unknown): ActionDetails | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("activity action must be structured");
  const action = readString(value, "action");
  const parameter = value["parameter"];
  const result = value["result"];
  if (
    action === null ||
    typeof parameter !== "string" ||
    (result !== undefined && typeof result !== "string")
  ) {
    throw new Error("activity action requires action and parameter strings");
  }
  return { action, parameter, ...(result === undefined ? {} : { result }) };
}

function readAuth(value: unknown): AuthSignal | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("elicitation auth must be structured");
  const url = readString(value, "url");
  if (url === null) throw new Error("elicitation auth requires a URL");
  const userId = optionalString(value, "userId");
  const providerName = optionalString(value, "providerName");
  return {
    url,
    ...(userId === undefined ? {} : { userId }),
    ...(providerName === undefined ? {} : { providerName }),
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (record[key] === undefined) return undefined;
  const value = readString(record, key);
  if (value === null) throw new Error(`${key} must be a nonempty string`);
  return value;
}

function isStateType(value: string | null): value is "started" | "completed" | "canceled" {
  return value === "started" || value === "completed" || value === "canceled";
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
