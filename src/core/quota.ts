export type QuotaSignal = {
  state: "low" | "exhausted";
  resetsAt: number | null;
  cooldownUntil: number;
};

export function quotaSignal(message: string, now: number): QuotaSignal | null {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid quota observation time");
  const text = message.slice(0, 16_384).replaceAll("_", " ");
  const remaining =
    /(?:quota|usage|limit|tokens?)[^\n]{0,80}?(\d+(?:\.\d+)?)\s*%\s*(?:remaining|left)/i.exec(
      text,
    ) ??
    /(\d+(?:\.\d+)?)\s*%\s*(?:of (?:your |the )?(?:quota|usage|limit)\s*)?(?:remaining|left)/i.exec(
      text,
    );
  const percent = remaining ? Number(remaining[1]) : null;
  const exhausted =
    /(?:quota|usage|rate|request|token)\s*limit(?:\s+(?:has been|was|is))?\s*(?:exceeded|reached|exhausted)|(?:exceeded|reached|exhausted)\s+(?:your\s+)?(?:quota|usage|rate|request|token)\s*limit|insufficient\s+quota|quota\s+(?:exceeded|exhausted)|hit\s+(?:your\s+|the\s+)?(?:usage\s+|rate\s+|quota\s+|session\s+|weekly\s+|daily\s+|monthly\s+|\d+-hour\s+)?limit|(?:weekly|daily|monthly|session|\d+-hour)\s+limit\s+reached|(?:HTTP|status(?:\s+code)?)\s*:?\s*429/i.test(
      text,
    ) || percent === 0;
  const low =
    (percent !== null && percent > 0 && percent <= 20) ||
    /(?:quota|usage)\s+(?:is\s+)?low|low\s+(?:quota|remaining\s+quota)/i.test(text);
  if (!exhausted && !low) return null;
  let resetsAt: number | null = null;
  const retry = /retry-after\s*:\s*([^\r\n]+)/i.exec(text)?.[1]?.trim();
  if (retry) {
    const parsed = /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
    if (Number.isSafeInteger(parsed) && parsed >= now) resetsAt = parsed;
  }
  if (resetsAt === null) {
    const iso =
      /(?:resets?|available|retry)[^\n]{0,40}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))/i.exec(
        text,
      )?.[1];
    const parsed = iso ? Date.parse(iso) : NaN;
    if (Number.isSafeInteger(parsed) && parsed >= now) resetsAt = parsed;
  }
  if (resetsAt === null) {
    const relative =
      /(?:resets?\s+in|try\s+again\s+in|retry\s+in|wait)\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|minutes?|seconds?|[dhms])\s*)+)/i.exec(
        text,
      )?.[1];
    if (relative) {
      const factors: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
      const duration = [
        ...relative.matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|minutes?|seconds?|[dhms])/gi),
      ].reduce((total, part) => total + Number(part[1]) * factors[part[2]![0]!.toLowerCase()]!, 0);
      const parsed = now + duration;
      if (Number.isSafeInteger(parsed) && parsed >= now) resetsAt = parsed;
    }
  }
  if (resetsAt === null) resetsAt = clockReset(text, now) ?? localRetryAt(text, now);
  return {
    state: exhausted ? "exhausted" : "low",
    resetsAt,
    cooldownUntil: exhausted ? (resetsAt ?? now + 15 * 60_000) : now,
  };
}

function clockReset(text: string, now: number): number | null {
  const match =
    /resets\s+(?:([a-z]{3})\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(
      text,
    );
  if (!match || Number(match[3]) > 12) return null;
  const month = match[1] ? MONTHS.indexOf(match[1].toLowerCase()) : null;
  if (month === -1) return null;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: match[6]!.trim(),
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return null;
  }
  const wall = (at: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(at).map((part) => [part.type, Number(part.value)]),
    );
    return Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
  };
  const today = new Date(wall(now));
  const hour = (Number(match[3]) % 12) + (match[5]!.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(match[4] ?? 0);
  const candidates =
    month === null
      ? [0, 1].map((day) =>
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day),
        )
      : [0, 1]
          .map((year) => Date.UTC(today.getUTCFullYear() + year, month, Number(match[2])))
          .filter((date) => new Date(date).getUTCDate() === Number(match[2]));
  for (const date of candidates) {
    const local = date + hour * 3_600_000 + minute * 60_000;
    const at = local - (wall(local) - local);
    if (at >= now) return at;
  }
  return null;
}

/**
 * Codex names its reset in the machine's local time, with no zone: "try again at Nov 11th, 2026
 * 6:35 AM", or only "6:35 AM" when the reset is today.
 */
function localRetryAt(text: string, now: number): number | null {
  const match =
    /try\s+again\s+at\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)\b/i.exec(
      text,
    );
  if (!match || Number(match[4]) > 12) return null;
  const month = match[1] ? MONTHS.indexOf(match[1].toLowerCase()) : null;
  if (month === -1) return null;
  const hour = (Number(match[4]) % 12) + (match[6]!.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(match[5]);
  const today = new Date(now);
  const candidates =
    month === null
      ? [0, 1].map((day) =>
          new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate() + day,
            hour,
            minute,
          ).getTime(),
        )
      : [new Date(Number(match[3]), month, Number(match[2]), hour, minute).getTime()];
  return candidates.find((at) => at >= now) ?? null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The runner's fixed text for an agent stopped at its usage limit. It carries only the parsed reset
 * time, which `quotaSignal` reads back on the Paws host, where the machine-local time is unknown.
 */
export function usageLimitCause(resetsAt: number | null): string {
  return resetsAt === null
    ? "usage limit reached."
    : `usage limit reached; resets ${new Date(resetsAt).toISOString()}.`;
}

/** What a person reads about a paused run, on the item and in Linear. */
export function usageLimitNotice(agent: string, resumeAt: number, now: number): string {
  const time = new Date(resumeAt).toISOString();
  const day =
    time.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? "" : `${time.slice(0, 10)} `;
  return `${agent.charAt(0).toUpperCase()}${agent.slice(1)} usage limit reached; resumes at ${day}${time.slice(11, 16)} UTC.`;
}
