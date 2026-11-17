import type { SlackFetch } from "./oauth";

export type SlackDirectMessageReason = "credentials" | "scope" | "recipient" | "unavailable";

const MESSAGES: Record<SlackDirectMessageReason, string> = {
  credentials: "Slack refused the bot token. Run paws login slack.",
  scope: "The Slack app is missing a scope it needs to open a direct message.",
  recipient: "Slack cannot open a direct message with this person.",
  unavailable: "Slack could not open a direct message.",
};

const REASONS: Record<string, SlackDirectMessageReason> = {
  invalid_auth: "credentials",
  token_revoked: "credentials",
  not_authed: "credentials",
  account_inactive: "credentials",
  missing_scope: "scope",
  user_not_found: "recipient",
  user_disabled: "recipient",
  cannot_dm_bot: "recipient",
  user_not_visible: "recipient",
};

export class SlackDirectMessageError extends Error {
  readonly reason: SlackDirectMessageReason;

  constructor(reason: SlackDirectMessageReason) {
    super(MESSAGES[reason]);
    this.name = "SlackDirectMessageError";
    this.reason = reason;
  }
}

export async function openSlackDirectMessage(input: {
  token: string;
  userId: string;
  fetch?: SlackFetch;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  if (!/^[UW][A-Z0-9]+$/.test(input.userId)) throw new SlackDirectMessageError("recipient");
  const fetchImpl = input.fetch ?? fetch;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 8_000)]);
  let data: unknown;
  try {
    data = await untilAborted(signal, async () => {
      const response = await fetchImpl("https://slack.com/api/conversations.open", {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({ users: input.userId }),
      });
      if (!response.ok) throw new SlackDirectMessageError("unavailable");
      return (await response.json()) as unknown;
    });
  } catch {
    throw new SlackDirectMessageError("unavailable");
  }
  if (!isRecord(data)) throw new SlackDirectMessageError("unavailable");
  if (data.ok !== true) {
    const code = typeof data.error === "string" ? data.error : "";
    throw new SlackDirectMessageError(
      Object.hasOwn(REASONS, code) ? REASONS[code]! : "unavailable",
    );
  }
  const channelId = isRecord(data.channel) ? data.channel.id : undefined;
  if (typeof channelId !== "string" || !/^D[A-Z0-9]+$/.test(channelId))
    throw new SlackDirectMessageError("unavailable");
  return channelId;
}

function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
