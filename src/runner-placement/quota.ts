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
  if (resetsAt === null) resetsAt = clockReset(text, now);
  return {
    state: exhausted ? "exhausted" : "low",
    resetsAt,
    cooldownUntil: exhausted ? (resetsAt ?? now + 15 * 60_000) : now,
  };
}

function clockReset(text: string, now: number): number | null {
  const match = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!match || Number(match[1]) > 12) return null;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: match[4]!.trim(),
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
  const hour = (Number(match[1]) % 12) + (match[3]!.toLowerCase() === "pm" ? 12 : 0);
  for (const day of [0, 1]) {
    const local = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + day,
      hour,
      Number(match[2] ?? 0),
    );
    const at = local - (wall(local) - local);
    if (at >= now) return at;
  }
  return null;
}
